package sshclient

import (
	"bufio"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
	"golang.org/x/net/proxy"

	"monossh/internal/model"
)

const defaultTimeout = 15 * time.Second

func Connect(ctx context.Context, item model.Connection) (*ssh.Client, error) {
	if item.Port == 0 {
		item.Port = 22
	}
	addr := net.JoinHostPort(item.Host, strconv.Itoa(item.Port))
	auth, err := authMethods(item)
	if err != nil {
		return nil, err
	}
	if len(auth) == 0 {
		return nil, errors.New("no auth method configured")
	}
	conn, err := dial(ctx, item.Proxy, addr)
	if err != nil {
		return nil, err
	}
	cfg := &ssh.ClientConfig{
		User:            item.Username,
		Auth:            auth,
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         defaultTimeout,
	}
	sshConn, chans, reqs, err := ssh.NewClientConn(conn, addr, cfg)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	return ssh.NewClient(sshConn, chans, reqs), nil
}

func Run(ctx context.Context, item model.Connection, command string) ([]byte, error) {
	client, err := Connect(ctx, item)
	if err != nil {
		return nil, err
	}
	defer client.Close()
	session, err := client.NewSession()
	if err != nil {
		return nil, err
	}
	defer session.Close()
	type result struct {
		out []byte
		err error
	}
	done := make(chan result, 1)
	go func() {
		out, err := session.CombinedOutput(command)
		done <- result{out: out, err: err}
	}()
	select {
	case <-ctx.Done():
		_ = session.Close()
		return nil, ctx.Err()
	case r := <-done:
		return r.out, r.err
	}
}

func SFTP(ctx context.Context, item model.Connection) (*sftp.Client, *ssh.Client, error) {
	client, err := Connect(ctx, item)
	if err != nil {
		return nil, nil, err
	}
	fs, err := sftp.NewClient(client)
	if err != nil {
		_ = client.Close()
		return nil, nil, err
	}
	return fs, client, nil
}

func authMethods(item model.Connection) ([]ssh.AuthMethod, error) {
	var methods []ssh.AuthMethod
	if strings.TrimSpace(item.PrivateKey) != "" {
		signer, err := signerFromKey(item.PrivateKey, item.Passphrase)
		if err != nil {
			return nil, err
		}
		methods = append(methods, ssh.PublicKeys(signer))
	}
	if item.Password != "" {
		methods = append(methods, ssh.Password(item.Password), ssh.KeyboardInteractive(func(user, instruction string, questions []string, echos []bool) ([]string, error) {
			answers := make([]string, len(questions))
			for i := range answers {
				answers[i] = item.Password
			}
			return answers, nil
		}))
	}
	return methods, nil
}

func signerFromKey(keyOrPath, passphrase string) (ssh.Signer, error) {
	value := strings.TrimSpace(keyOrPath)
	if strings.HasPrefix(value, "~") {
		if home, err := os.UserHomeDir(); err == nil {
			value = filepath.Join(home, strings.TrimPrefix(value, "~"))
		}
	}
	var data []byte
	if strings.Contains(value, "BEGIN ") {
		data = []byte(value)
	} else {
		b, err := os.ReadFile(value)
		if err != nil {
			return nil, fmt.Errorf("read private key: %w", err)
		}
		data = b
	}
	if passphrase != "" {
		return ssh.ParsePrivateKeyWithPassphrase(data, []byte(passphrase))
	}
	return ssh.ParsePrivateKey(data)
}

func dial(ctx context.Context, cfg model.ProxyConfig, target string) (net.Conn, error) {
	switch strings.ToLower(strings.TrimSpace(cfg.Type)) {
	case "", "none", "direct":
		var d net.Dialer
		return d.DialContext(ctx, "tcp", target)
	case "socks", "socks5":
		return dialSOCKS5(cfg, target)
	case "http", "https":
		return dialHTTPConnect(ctx, cfg, target)
	default:
		return nil, fmt.Errorf("unsupported proxy type %q", cfg.Type)
	}
}

func dialSOCKS5(cfg model.ProxyConfig, target string) (net.Conn, error) {
	proxyAddr := net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
	var auth *proxy.Auth
	if cfg.Username != "" || cfg.Password != "" {
		auth = &proxy.Auth{User: cfg.Username, Password: cfg.Password}
	}
	dialer, err := proxy.SOCKS5("tcp", proxyAddr, auth, &net.Dialer{Timeout: defaultTimeout})
	if err != nil {
		return nil, err
	}
	return dialer.Dial("tcp", target)
}

func dialHTTPConnect(ctx context.Context, cfg model.ProxyConfig, target string) (net.Conn, error) {
	proxyAddr := net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
	var d net.Dialer
	conn, err := d.DialContext(ctx, "tcp", proxyAddr)
	if err != nil {
		return nil, err
	}
	_ = conn.SetDeadline(time.Now().Add(defaultTimeout))
	req := &http.Request{
		Method: "CONNECT",
		URL:    &url.URL{Opaque: target},
		Host:   target,
		Header: make(http.Header),
	}
	if cfg.Username != "" || cfg.Password != "" {
		token := base64.StdEncoding.EncodeToString([]byte(cfg.Username + ":" + cfg.Password))
		req.Header.Set("Proxy-Authorization", "Basic "+token)
	}
	if err := req.Write(conn); err != nil {
		_ = conn.Close()
		return nil, err
	}
	resp, err := http.ReadResponse(bufio.NewReader(conn), req)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_ = conn.Close()
		return nil, fmt.Errorf("http proxy connect failed: %s", resp.Status)
	}
	_ = conn.SetDeadline(time.Time{})
	return conn, nil
}
