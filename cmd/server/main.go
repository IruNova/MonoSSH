package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"mime"
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
		store: st,
		upgrader: websocket.Upgrader{
			ReadBufferSize:  32 * 1024,
			WriteBufferSize: 32 * 1024,
			CheckOrigin:     func(r *http.Request) bool { return true },
		},
	}

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
	client, err := sshclient.Connect(ctx, item)
	cancel()
	if err != nil {
		_ = writeWS(websocket.TextMessage, []byte("\r\n\x1b[31mConnection failed: "+err.Error()+"\x1b[0m\r\n"))
		return
	}
	defer client.Close()
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
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	fs, client, err := sshclient.SFTP(ctx, item)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	defer client.Close()
	defer fs.Close()
	f, err := fs.Open(remotePath)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	defer f.Close()
	if stat, err := f.Stat(); err == nil {
		w.Header().Set("Content-Length", strconv.FormatInt(stat.Size(), 10))
		if ct := mime.TypeByExtension(path.Ext(remotePath)); ct != "" {
			w.Header().Set("Content-Type", ct)
		} else {
			w.Header().Set("Content-Type", "application/octet-stream")
		}
	}
	w.Header().Set("Content-Disposition", "attachment; filename=\""+strings.ReplaceAll(path.Base(remotePath), "\"", "")+"\"")
	_, _ = io.Copy(w, f)
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
	if err := r.ParseMultipartForm(512 << 20); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()
	fs, client, err := sshclient.SFTP(ctx, item)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	defer client.Close()
	defer fs.Close()
	remoteDir = cleanRemotePath(fs, remoteDir)
	count := 0
	for _, files := range r.MultipartForm.File {
		for _, header := range files {
			in, err := header.Open()
			if err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			name := path.Base(strings.ReplaceAll(header.Filename, "\\", "/"))
			out, err := fs.Create(path.Join(remoteDir, name))
			if err != nil {
				_ = in.Close()
				writeError(w, http.StatusBadGateway, err)
				return
			}
			_, copyErr := io.Copy(out, in)
			_ = out.Close()
			_ = in.Close()
			if copyErr != nil {
				writeError(w, http.StatusBadGateway, copyErr)
				return
			}
			count++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "count": count})
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
		ID        string `json:"id"`
		Path      string `json:"path"`
		Recursive bool   `json:"recursive"`
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
	if req.Path == "" || req.Path == "/" {
		writeError(w, http.StatusBadRequest, errors.New("refuse to delete empty path or root"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	fs, client, err := sshclient.SFTP(ctx, item)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	defer client.Close()
	defer fs.Close()
	if err := removeRemote(fs, req.Path, req.Recursive); err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
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
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	cmd := `printf "UPTIME\t"; (uptime -p 2>/dev/null || uptime) | tr '\n' ' '; printf "\nLOAD\t"; cat /proc/loadavg 2>/dev/null | awk '{print $1" "$2" "$3}'; printf "MEM\t"; free -m 2>/dev/null | awk '/Mem:/ {printf "%s/%s MB %.0f%%\n",$3,$2,$3*100/$2}'; printf "DISK\t"; df -P -h / 2>/dev/null | awk 'NR==2 {printf "%s/%s %s\n",$3,$2,$5}'; printf "PROC\n"; ps -eo pmem,pcpu,comm --sort=-pcpu 2>/dev/null | head -6`
	out, err := sshclient.Run(ctx, item, cmd)
	if err != nil && len(out) == 0 {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"output": string(out)})
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

func removeRemote(fs *sftp.Client, p string, recursive bool) error {
	info, err := fs.Stat(p)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fs.Remove(p)
	}
	if !recursive {
		return fs.RemoveDirectory(p)
	}
	entries, err := fs.ReadDir(p)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		if name == "." || name == ".." {
			continue
		}
		if err := removeRemote(fs, path.Join(p, name), recursive); err != nil {
			return err
		}
	}
	return fs.RemoveDirectory(p)
}

func mergeQuery(raw, key, value string) string {
	if raw == "" {
		return key + "=" + value
	}
	return raw + "&" + key + "=" + value
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
