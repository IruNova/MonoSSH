package model

import "time"

type ProxyConfig struct {
	Type     string `json:"type"` // none, socks5, http
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
}

type Connection struct {
	ID         string      `json:"id"`
	Name       string      `json:"name"`
	Group      string      `json:"group"`
	Host       string      `json:"host"`
	Port       int         `json:"port"`
	Username   string      `json:"username"`
	Password   string      `json:"password,omitempty"`
	PrivateKey string      `json:"privateKey,omitempty"`
	Passphrase string      `json:"passphrase,omitempty"`
	Proxy      ProxyConfig `json:"proxy"`
	CreatedAt  time.Time   `json:"createdAt"`
	UpdatedAt  time.Time   `json:"updatedAt"`
}

type FileEntry struct {
	Name    string    `json:"name"`
	Path    string    `json:"path"`
	Size    int64     `json:"size"`
	Mode    string    `json:"mode"`
	ModTime time.Time `json:"modTime"`
	IsDir   bool      `json:"isDir"`
}
