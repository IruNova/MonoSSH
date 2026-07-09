package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

	"monossh/internal/model"
	"monossh/internal/sshclient"
	"monossh/internal/store"
)

type api struct {
	store    *store.Store
	sshCache *sshclient.SSHCache
	upgrader websocket.Upgrader
}

func main() {
	addr := flag.String("addr", "127.0.0.1:0", "listen address")
	data := flag.String("data", defaultStorePath(), "connection store path")
	flag.Parse()

	st, err := store.New(*data)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	a := &api{
		store:    st,
		sshCache: sshclient.NewSSHCache(5*time.Minute, 32),
		upgrader: websocket.Upgrader{
			ReadBufferSize:  32 * 1024,
			WriteBufferSize: 32 * 1024,
			CheckOrigin:     func(r *http.Request) bool { return true },
		},
	}
	defer a.sshCache.Close()

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, http.StatusOK, map[string]any{"ok": true}) })
	mux.HandleFunc("/api/connections", a.connections)
	mux.HandleFunc("/api/connections/", a.connectionByID)
	mux.HandleFunc("/api/system", a.system)
	mux.HandleFunc("/api/fs/list", a.fsList)
	mux.HandleFunc("/api/fs/download", a.fsDownload)
	mux.HandleFunc("/api/fs/upload", a.fsUpload)
	mux.HandleFunc("/api/fs/mkdir", a.fsMkdir)
	mux.HandleFunc("/api/fs/delete", a.fsDelete)
	mux.HandleFunc("/api/fs/rename", a.fsRename)
	mux.HandleFunc("/ws/terminal", a.terminal)

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	if tcp, ok := ln.Addr().(*net.TCPAddr); ok {
		fmt.Printf("MONOSSH_PORT=%d\n", tcp.Port)
	}
	log.Printf("MonoSSH backend listening on %s", ln.Addr())
	server := &http.Server{Handler: withCORS(mux)}
	log.Fatal(server.Serve(ln))
}

func defaultStorePath() string {
	if v := os.Getenv("MONOSSH_STORE"); v != "" {
		return v
	}
	if dir, err := os.UserConfigDir(); err == nil {
		return filepath.Join(dir, "monossh", "connections.json")
	}
	return "connections.json"
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Expose-Headers", "Content-Length, Content-Disposition")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *api) connections(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, a.store.List())
	case http.MethodPost:
		var item model.Connection
		if err := json.NewDecoder(r.Body).Decode(&item); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		saved, err := a.store.Save(item)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, saved)
	default:
		writeError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
	}
}

func (a *api) connectionByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/connections/")
	if id == "" {
		writeError(w, http.StatusNotFound, errors.New("missing id"))
		return
	}
	switch r.Method {
	case http.MethodPut:
		var item model.Connection
		if err := json.NewDecoder(r.Body).Decode(&item); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		item.ID = id
		saved, err := a.store.Save(item)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, saved)
	case http.MethodDelete:
		if err := a.store.Delete(id); err != nil {
			writeError(w, http.StatusNotFound, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	default:
		writeError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
	}
}

func (a *api) getConnectionFromRequest(r *http.Request) (model.Connection, error) {
	id := r.URL.Query().Get("id")
	if id == "" {
		id = r.URL.Query().Get("connectionId")
	}
	if id == "" {
		return model.Connection{}, errors.New("missing connection id")
	}
	item, ok := a.store.Get(id)
	if !ok {
		return model.Connection{}, fmt.Errorf("connection %s not found", id)
	}
	return item, nil
}

func (a *api) terminal(w http.ResponseWriter, r *http.Request) {
	item, err := a.getConnectionFromRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	cols := atoiDefault(r.URL.Query().Get("cols"), 100)
	rows := atoiDefault(r.URL.Query().Get("rows"), 30)
	ws, err := a.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer ws.Close()

	var writeMu sync.Mutex
	writeWS := func(messageType int, b []byte) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return ws.WriteMessage(messageType, b)
	}
	_ = writeWS(websocket.TextMessage, []byte("\r\n\x1b[2mConnecting to "+item.Username+"@"+item.Host+"...\x1b[0m\r\n"))

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	client, err := a.sshCache.Get(ctx, item)
	cancel()
	if err != nil {
		_ = writeWS(websocket.TextMessage, []byte("\r\n\x1b[31mConnection failed: "+err.Error()+"\x1b[0m\r\n"))
		return
	}
	session, err := client.NewSession()
	if err != nil {
		_ = writeWS(websocket.TextMessage, []byte("\r\n\x1b[31mOpen session failed: "+err.Error()+"\x1b[0m\r\n"))
		return
	}
	defer session.Close()

	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}
	if err := session.RequestPty("xterm-256color", rows, cols, modes); err != nil {
		_ = writeWS(websocket.TextMessage, []byte("\r\n\x1b[31mRequest PTY failed: "+err.Error()+"\x1b[0m\r\n"))
		return
	}
	stdin, err := session.StdinPipe()
	if err != nil {
		_ = writeWS(websocket.TextMessage, []byte("\r\n\x1b[31mOpen stdin failed: "+err.Error()+"\x1b[0m\r\n"))
		return
	}
	stdout, err := session.StdoutPipe()
	if err != nil {
		_ = writeWS(websocket.TextMessage, []byte("\r\n\x1b[31mOpen stdout failed: "+err.Error()+"\x1b[0m\r\n"))
		return
	}
	stderr, err := session.StderrPipe()
	if err != nil {
		_ = writeWS(websocket.TextMessage, []byte("\r\n\x1b[31mOpen stderr failed: "+err.Error()+"\x1b[0m\r\n"))
		return
	}
	if err := session.Shell(); err != nil {
		_ = writeWS(websocket.TextMessage, []byte("\r\n\x1b[31mStart shell failed: "+err.Error()+"\x1b[0m\r\n"))
		return
	}

	done := make(chan struct{})
	copyToWS := func(rd io.Reader) {
		buf := make([]byte, 32*1024)
		for {
			n, err := rd.Read(buf)
			if n > 0 {
				if werr := writeWS(websocket.BinaryMessage, buf[:n]); werr != nil {
					break
				}
			}
			if err != nil {
				break
			}
		}
	}
	go copyToWS(stdout)
	go copyToWS(stderr)
	go func() {
		_ = session.Wait()
		close(done)
	}()

	for {
		select {
		case <-done:
			_ = writeWS(websocket.TextMessage, []byte("\r\n\x1b[2mSession closed.\x1b[0m\r\n"))
			return
		default:
		}
		mt, msg, err := ws.ReadMessage()
		if err != nil {
			return
		}
		if mt == websocket.TextMessage && handleControlMessage(session, msg) {
			continue
		}
		_, _ = stdin.Write(msg)
	}
}

func handleControlMessage(session *ssh.Session, msg []byte) bool {
	if len(msg) == 0 || msg[0] != '{' {
		return false
	}
	var payload struct {
		Type string `json:"type"`
		Cols int    `json:"cols"`
		Rows int    `json:"rows"`
	}
	if err := json.Unmarshal(msg, &payload); err != nil || payload.Type != "resize" {
		return false
	}
	if payload.Cols > 0 && payload.Rows > 0 {
		_ = session.WindowChange(payload.Rows, payload.Cols)
	}
	return true
}

func (a *api) fsList(w http.ResponseWriter, r *http.Request) {
	item, err := a.getConnectionFromRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	remotePath := r.URL.Query().Get("path")
	if remotePath == "" {
		remotePath = "."
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	fs, client, err := sshclient.SFTP(ctx, item)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	defer client.Close()
	defer fs.Close()
	realPath := cleanRemotePath(fs, remotePath)
	infos, err := fs.ReadDir(realPath)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	entries := make([]model.FileEntry, 0, len(infos))
	for _, info := range infos {
		name := info.Name()
		if name == "." || name == ".." {
			continue
		}
		entries = append(entries, model.FileEntry{
			Name:    name,
			Path:    path.Join(realPath, name),
			Size:    info.Size(),
			Mode:    info.Mode().String(),
			ModTime: info.ModTime(),
			IsDir:   info.IsDir(),
		})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDir != entries[j].IsDir {
			return entries[i].IsDir
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
	writeJSON(w, http.StatusOK, map[string]any{"path": realPath, "entries": entries})
}

func (a *api) fsDownload(w http.ResponseWriter, r *http.Request) {
	item, err := a.getConnectionFromRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	remotePath := r.URL.Query().Get("path")
	if remotePath == "" {
		writeError(w, http.StatusBadRequest, errors.New("missing path"))
		return
	}
	client, err := a.sshCache.Get(r.Context(), item)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	fs, err := sftp.NewClient(client)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	defer fs.Close()
	f, err := fs.Open(remotePath)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", "attachment; filename=\""+strings.ReplaceAll(path.Base(remotePath), "\"", "")+"\"")
	w.WriteHeader(http.StatusOK)
	flusher, hasFlush := w.(http.Flusher)
	buf := make([]byte, 32*1024)
	for {
		if err := r.Context().Err(); err != nil {
			log.Printf("download cancelled by client: %v", err)
			return
		}
		n, readErr := f.Read(buf)
		if n > 0 {
			if _, wErr := w.Write(buf[:n]); wErr != nil {
				log.Printf("download write error: %v", wErr)
				return
			}
			if hasFlush {
				flusher.Flush()
			}
		}
		if readErr != nil {
			if readErr != io.EOF {
				log.Printf("download read error: %v", readErr)
			}
			return
		}
	}
}

func (a *api) fsUpload(w http.ResponseWriter, r *http.Request) {
	item, err := a.getConnectionFromRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	remoteDir := r.URL.Query().Get("path")
	if remoteDir == "" {
		remoteDir = "."
	}

	uploadReader, err := r.MultipartReader()
	if err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("read multipart: %w", err))
		return
	}

	client, err := a.sshCache.Get(r.Context(), item)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	fs, err := sftp.NewClient(client)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	defer fs.Close()

	if realDir, err := fs.RealPath(remoteDir); err == nil && realDir != "" {
		remoteDir = realDir
	} else {
		remoteDir = path.Clean("/" + remoteDir)
	}

	type fileResult struct {
		Name   string `json:"name"`
		Size   int64  `json:"size"`
		OK     bool   `json:"ok"`
		Err    string `json:"error,omitempty"`
	}
	results := make([]fileResult, 0)
	count := 0

	for {
		if err := r.Context().Err(); err != nil {
			writeError(w, http.StatusBadGateway, fmt.Errorf("client disconnected during upload: %w", err))
			return
		}
		part, partErr := uploadReader.NextPart()
		if partErr == io.EOF {
			break
		}
		if partErr != nil {
			writeError(w, http.StatusBadRequest, partErr)
			return
		}
		name := path.Base(strings.ReplaceAll(part.FileName(), "\\", "/"))
		if name == "." || name == "" {
			_ = part.Close()
			continue
		}
		targetPath := path.Join(remoteDir, name)
		fr := fileResult{Name: name}
		err := func() error {
			defer part.Close()
			out, err := fs.Create(targetPath)
			if err != nil {
				return fmt.Errorf("create remote file: %w", err)
			}
			written, copyErr := io.Copy(out, part)
			if syncErr := out.Sync(); syncErr != nil && copyErr == nil {
				copyErr = fmt.Errorf("sync remote file: %w", syncErr)
			}
			if closeErr := out.Close(); closeErr != nil && copyErr == nil {
				copyErr = fmt.Errorf("close remote file: %w", closeErr)
			}
			if copyErr != nil {
				_ = fs.Remove(targetPath)
				return copyErr
			}
			if info, statErr := fs.Stat(targetPath); statErr != nil {
				_ = fs.Remove(targetPath)
				return fmt.Errorf("verify remote file: %w", statErr)
			} else if info.Size() != written {
				_ = fs.Remove(targetPath)
				return fmt.Errorf("size mismatch: expected %d, got %d", written, info.Size())
			}
			fr.Size = written
			return nil
		}()
		if err != nil {
			fr.Err = err.Error()
			fr.OK = false
		} else {
			fr.OK = true
			count++
		}
		results = append(results, fr)
	}

	if count == 0 && len(results) > 0 {
		writeError(w, http.StatusBadGateway, fmt.Errorf("all uploads failed: %s", results[0].Err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "count": count, "results": results})
}

func (a *api) fsMkdir(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID   string `json:"id"`
		Path string `json:"path"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if req.ID != "" {
		r.URL.RawQuery = mergeQuery(r.URL.RawQuery, "id", req.ID)
	}
	item, err := a.getConnectionFromRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, errors.New("missing name"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	fs, client, err := sshclient.SFTP(ctx, item)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	defer client.Close()
	defer fs.Close()
	base := cleanRemotePath(fs, req.Path)
	if err := fs.Mkdir(path.Join(base, req.Name)); err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (a *api) fsDelete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID        string   `json:"id"`
		Path      string   `json:"path"`
		Paths     []string `json:"paths"`
		Recursive bool     `json:"recursive"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if req.ID != "" {
		r.URL.RawQuery = mergeQuery(r.URL.RawQuery, "id", req.ID)
	}
	item, err := a.getConnectionFromRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	paths := req.Paths
	if len(paths) == 0 && req.Path != "" {
		paths = []string{req.Path}
	}
	paths, err = normalizeDeletePaths(paths)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	args := make([]string, 0, len(paths))
	for _, p := range paths {
		args = append(args, shellQuote(p))
	}
	ctx := requestContext(r)
	client, err := a.sshCache.Get(ctx, item)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	session, err := client.NewSession()
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	defer session.Close()
	cmd := "rm -rf -- " + strings.Join(args, " ")
	type result struct {
		out []byte
		err error
	}
	done := make(chan result, 1)
	go func() {
		out, err := session.CombinedOutput(cmd)
		done <- result{out, err}
	}()
	select {
	case <-ctx.Done():
		_ = session.Signal(ssh.SIGKILL)
		_ = session.Close()
		writeError(w, http.StatusBadGateway, ctx.Err())
		return
	case res := <-done:
		if res.err != nil {
			msg := res.err.Error()
			if len(res.out) > 0 {
				msg += ": " + strings.TrimSpace(string(res.out))
			}
			writeError(w, http.StatusBadGateway, errors.New(msg))
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "count": len(paths), "output": string(res.out)})
	}
}

func (a *api) fsRename(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID      string `json:"id"`
		OldPath string `json:"oldPath"`
		NewPath string `json:"newPath"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if req.ID != "" {
		r.URL.RawQuery = mergeQuery(r.URL.RawQuery, "id", req.ID)
	}
	item, err := a.getConnectionFromRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if req.OldPath == "" || req.NewPath == "" {
		writeError(w, http.StatusBadRequest, errors.New("missing path"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	fs, client, err := sshclient.SFTP(ctx, item)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	defer client.Close()
	defer fs.Close()
	if err := fs.Rename(req.OldPath, req.NewPath); err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (a *api) system(w http.ResponseWriter, r *http.Request) {
	item, err := a.getConnectionFromRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	cmd := `cpu_sample() { awk 'NR==1 { idle=$5+$6; total=0; for (i=2; i<=NF; i++) total += $i; print total, idle }' /proc/stat 2>/dev/null; }
first="$(cpu_sample)"
sleep 0.25
second="$(cpu_sample)"
cpu="$(awk -v a="$first" -v b="$second" 'BEGIN { split(a,x," "); split(b,y," "); dt=y[1]-x[1]; di=y[2]-x[2]; if (dt>0) printf "%.0f", (dt-di)*100/dt; else printf "0" }')"
printf "CPU\t%s\n" "$cpu"
printf "UPTIME\t"; (uptime -p 2>/dev/null || uptime) | sed 's/^up //' | tr '\n' ' '; printf "\n"
printf "LOAD\t"; awk '{print $1"\t"$2"\t"$3}' /proc/loadavg 2>/dev/null || printf -- "-\t-\t-\n"
free -m 2>/dev/null | awk '/Mem:/ { pct=$2>0?$3*100/$2:0; printf "MEM\t%s\t%s\t%.0f\n",$3,$2,pct }'
df -P -h / 2>/dev/null | awk 'NR==2 { gsub("%","",$5); printf "DISK\t%s\t%s\t%s\n",$3,$2,$5 }'
printf "PROC\n"; ps -eo pcpu,pmem,comm --sort=-pcpu 2>/dev/null | awk 'NR>1 && NR<=6 {printf "%s\t%s\t%s\n",$1,$2,$3}'`
	ctx := requestContext(r)
	client, err := a.sshCache.Get(ctx, item)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	session, err := client.NewSession()
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	defer session.Close()
	type result struct {
		out []byte
		err error
	}
	done := make(chan result, 1)
	go func() {
		out, err := session.CombinedOutput(cmd)
		done <- result{out, err}
	}()
	select {
	case <-ctx.Done():
		_ = session.Signal(ssh.SIGKILL)
		_ = session.Close()
		writeError(w, http.StatusBadGateway, ctx.Err())
		return
	case res := <-done:
		if res.err != nil && len(res.out) == 0 {
			writeError(w, http.StatusBadGateway, res.err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"output": string(res.out)})
	}
}

func cleanRemotePath(fs *sftp.Client, p string) string {
	if p == "" {
		p = "."
	}
	if real, err := fs.RealPath(p); err == nil && real != "" {
		return real
	}
	if strings.HasPrefix(p, "/") {
		return path.Clean(p)
	}
	return path.Clean("/" + p)
}

func normalizeDeletePaths(paths []string) ([]string, error) {
	seen := map[string]bool{}
	out := make([]string, 0, len(paths))
	for _, p := range paths {
		p = strings.TrimSpace(p)
		if p == "" {
			return nil, errors.New("refuse to delete empty path")
		}
		p = path.Clean(strings.ReplaceAll(p, "\\", "/"))
		if p == "." || p == "/" || p == ".." || strings.HasPrefix(p, "../") {
			return nil, fmt.Errorf("refuse to delete unsafe path %q", p)
		}
		if strings.Trim(p, "/.") == "" {
			return nil, fmt.Errorf("refuse to delete unsafe path %q", p)
		}
		if !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return nil, errors.New("missing path")
	}
	return out, nil
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'"
}

func mergeQuery(raw, key, value string) string {
	if raw == "" {
		return key + "=" + value
	}
	return raw + "&" + key + "=" + value
}

func requestContext(r *http.Request) context.Context {
	return context.WithoutCancel(r.Context())
}

func atoiDefault(s string, def int) int {
	v, err := strconv.Atoi(s)
	if err != nil || v <= 0 {
		return def
	}
	return v
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]any{"error": err.Error()})
}
