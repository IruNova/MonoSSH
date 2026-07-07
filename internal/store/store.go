package store

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"monossh/internal/model"
)

type Store struct {
	path string
	mu   sync.RWMutex
	data []model.Connection
}

func New(path string) (*Store, error) {
	s := &Store{path: path}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		s.data = []model.Connection{}
		return s, s.persistLocked()
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(strings.TrimSpace(string(b))) == 0 {
		s.data = []model.Connection{}
		return s, nil
	}
	if err := json.Unmarshal(b, &s.data); err != nil {
		return nil, err
	}
	if s.data == nil {
		s.data = []model.Connection{}
	}
	return s, nil
}

func (s *Store) List() []model.Connection {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := append([]model.Connection{}, s.data...)
	sort.Slice(out, func(i, j int) bool {
		if out[i].Group == out[j].Group {
			return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
		}
		return strings.ToLower(out[i].Group) < strings.ToLower(out[j].Group)
	})
	return out
}

func (s *Store) Get(id string) (model.Connection, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, item := range s.data {
		if item.ID == id {
			return item, true
		}
	}
	return model.Connection{}, false
}

func (s *Store) Save(item model.Connection) (model.Connection, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	if item.Port == 0 {
		item.Port = 22
	}
	if item.Proxy.Type == "" {
		item.Proxy.Type = "none"
	}
	if item.Group == "" {
		item.Group = "默认"
	}
	item.UpdatedAt = now
	if item.ID == "" {
		item.ID = newID()
		item.CreatedAt = now
		s.data = append(s.data, item)
		return item, s.persistLocked()
	}
	for i := range s.data {
		if s.data[i].ID == item.ID {
			item.CreatedAt = s.data[i].CreatedAt
			s.data[i] = item
			return item, s.persistLocked()
		}
	}
	item.CreatedAt = now
	s.data = append(s.data, item)
	return item, s.persistLocked()
}

func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.data {
		if s.data[i].ID == id {
			s.data = append(s.data[:i], s.data[i+1:]...)
			return s.persistLocked()
		}
	}
	return os.ErrNotExist
}

func (s *Store) persistLocked() error {
	b, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func newID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return hex.EncodeToString([]byte(time.Now().Format(time.RFC3339Nano)))
	}
	return hex.EncodeToString(b)
}
