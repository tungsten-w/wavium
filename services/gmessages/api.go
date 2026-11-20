// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package main

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"sync"
	"time"
)

// Server: the HTTP API Bun calls on the internal network. Every request needs
// `Authorization: Bearer <GMESSAGES_SECRET>`; the sidecar is never published.
//
//	GET    /healthz                               (no secret: liveness only)
//	GET    /v1/events                             event stream (text/event-stream, one JSON per event)
//	GET    /v1/users/{uid}/status
//	POST   /v1/users/{uid}/pair/qr                -> {qr}
//	POST   /v1/users/{uid}/pair/google            {cookies} -> {emoji}
//	PUT    /v1/users/{uid}/session                {session} connect with a stored session
//	DELETE /v1/users/{uid}/session                unpair (phone forgets this browser)
//	GET    /v1/users/{uid}/conversations?count=
//	POST   /v1/users/{uid}/conversations          {number} -> conversation
//	GET    /v1/users/{uid}/conversations/{id}/messages?count=
//	POST   /v1/users/{uid}/send                   {conversation_id, text, tmp_id}
//	POST   /v1/users/{uid}/read                   {conversation_id, message_id}
//	POST   /v1/users/{uid}/media                  {media_id, key} -> bytes
type Server struct {
	secret   []byte
	newPhone func(uid string, emit Emit) Phone

	mu     sync.Mutex
	phones map[string]Phone
	subs   map[chan Event]struct{}
}

const maxBody = 1 << 20

var uidRe = regexp.MustCompile(`^[A-Za-z0-9_.@-]{1,64}$`)

func NewServer(secret string, newPhone func(uid string, emit Emit) Phone) *Server {
	return &Server{secret: []byte(secret), newPhone: newPhone, phones: map[string]Phone{}, subs: map[chan Event]struct{}{}}
}

func (s *Server) emit(e Event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for ch := range s.subs {
		select {
		case ch <- e:
		default: // a slow reader loses events; Bun resyncs on reconnect
		}
	}
}

func (s *Server) phone(uid string) Phone {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.phones[uid]
	if !ok {
		p = s.newPhone(uid, func(e Event) { e.UID = uid; s.emit(e) })
		s.phones[uid] = p
	}
	return p
}

func (s *Server) drop(uid string) {
	s.mu.Lock()
	p := s.phones[uid]
	delete(s.phones, uid)
	s.mu.Unlock()
	if p != nil {
		p.Close()
	}
}

func (s *Server) authorized(r *http.Request) bool {
	h := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if len(h) <= len(prefix) || h[:len(prefix)] != prefix {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(h[len(prefix):]), s.secret) == 1
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, err error) {
	status := http.StatusBadGateway
	code := "phone"
	switch {
	case errors.Is(err, ErrNotPaired):
		status, code = http.StatusConflict, "not_paired"
	case errors.Is(err, ErrNotFound):
		status, code = http.StatusNotFound, "not_found"
	case errors.Is(err, ErrBadInput):
		status, code = http.StatusBadRequest, "invalid_input"
	case errors.Is(err, context.DeadlineExceeded):
		status, code = http.StatusGatewayTimeout, "timeout"
	}
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": err.Error()}})
}

func readJSON(r *http.Request, v any) error {
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, maxBody))
	if err := dec.Decode(v); err != nil {
		return fmt.Errorf("%w: body must be JSON (%v)", ErrBadInput, err)
	}
	return nil
}

func count(r *http.Request, def, max int) int {
	n, err := strconv.Atoi(r.URL.Query().Get("count"))
	if err != nil || n <= 0 {
		return def
	}
	if n > max {
		return max
	}
	return n
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]bool{"ok": true}) })
	mux.HandleFunc("GET /v1/events", s.events)
	user := func(pattern string, h func(w http.ResponseWriter, r *http.Request, uid string)) {
		mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			uid := r.PathValue("uid")
			if !uidRe.MatchString(uid) {
				writeErr(w, fmt.Errorf("%w: bad user id", ErrBadInput))
				return
			}
			h(w, r, uid)
		})
	}
	user("GET /v1/users/{uid}/status", func(w http.ResponseWriter, r *http.Request, uid string) {
		writeJSON(w, 200, s.phone(uid).Status())
	})
	user("POST /v1/users/{uid}/pair/qr", func(w http.ResponseWriter, r *http.Request, uid string) {
		s.drop(uid) // a new pairing starts from a clean client
		qr, err := s.phone(uid).PairQR(r.Context())
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]string{"qr": qr})
	})
	user("POST /v1/users/{uid}/pair/google", func(w http.ResponseWriter, r *http.Request, uid string) {
		var body struct {
			Cookies map[string]string `json:"cookies"`
		}
		if err := readJSON(r, &body); err != nil {
			writeErr(w, err)
			return
		}
		if len(body.Cookies) == 0 || len(body.Cookies) > 50 {
			writeErr(w, fmt.Errorf("%w: cookies missing", ErrBadInput))
			return
		}
		s.drop(uid)
		emoji, err := s.phone(uid).PairGoogle(r.Context(), body.Cookies)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]string{"emoji": emoji})
	})
	user("PUT /v1/users/{uid}/session", func(w http.ResponseWriter, r *http.Request, uid string) {
		var body struct {
			Session json.RawMessage `json:"session"`
		}
		if err := readJSON(r, &body); err != nil {
			writeErr(w, err)
			return
		}
		if len(body.Session) == 0 {
			writeErr(w, fmt.Errorf("%w: session missing", ErrBadInput))
			return
		}
		s.drop(uid)
		if err := s.phone(uid).Connect(r.Context(), body.Session); err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, s.phone(uid).Status())
	})
	user("DELETE /v1/users/{uid}/session", func(w http.ResponseWriter, r *http.Request, uid string) {
		err := s.phone(uid).Unpair(r.Context())
		s.drop(uid)
		if err != nil && !errors.Is(err, ErrNotPaired) {
			// The phone may be off: Wavium forgets the session anyway.
			writeJSON(w, 200, map[string]any{"unpaired": true, "warning": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]bool{"unpaired": true})
	})
	user("GET /v1/users/{uid}/conversations", func(w http.ResponseWriter, r *http.Request, uid string) {
		cs, err := s.phone(uid).Conversations(r.Context(), count(r, 50, 200))
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"conversations": cs})
	})
	user("POST /v1/users/{uid}/conversations", func(w http.ResponseWriter, r *http.Request, uid string) {
		var body struct {
			Number string `json:"number"`
		}
		if err := readJSON(r, &body); err != nil {
			writeErr(w, err)
			return
		}
		if !validNumber(body.Number) {
			writeErr(w, fmt.Errorf("%w: number must be a phone number", ErrBadInput))
			return
		}
		c, err := s.phone(uid).StartConversation(r.Context(), body.Number)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, c)
	})
	user("GET /v1/users/{uid}/conversations/{cid}/messages", func(w http.ResponseWriter, r *http.Request, uid string) {
		ms, err := s.phone(uid).Messages(r.Context(), r.PathValue("cid"), count(r, 50, 200))
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"messages": ms})
	})
	user("POST /v1/users/{uid}/send", func(w http.ResponseWriter, r *http.Request, uid string) {
		var body struct {
			ConversationID string `json:"conversation_id"`
			Text           string `json:"text"`
			TmpID          string `json:"tmp_id"`
		}
		if err := readJSON(r, &body); err != nil {
			writeErr(w, err)
			return
		}
		if body.ConversationID == "" || body.Text == "" || len(body.Text) > 10_000 || body.TmpID == "" || len(body.TmpID) > 64 {
			writeErr(w, fmt.Errorf("%w: conversation_id, text (max 10000) and tmp_id are needed", ErrBadInput))
			return
		}
		if err := s.phone(uid).Send(r.Context(), body.ConversationID, body.Text, body.TmpID); err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"sent": true, "tmp_id": body.TmpID})
	})
	user("POST /v1/users/{uid}/read", func(w http.ResponseWriter, r *http.Request, uid string) {
		var body struct {
			ConversationID string `json:"conversation_id"`
			MessageID      string `json:"message_id"`
		}
		if err := readJSON(r, &body); err != nil {
			writeErr(w, err)
			return
		}
		if err := s.phone(uid).MarkRead(r.Context(), body.ConversationID, body.MessageID); err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"read": true})
	})
	user("POST /v1/users/{uid}/media", func(w http.ResponseWriter, r *http.Request, uid string) {
		var body struct {
			MediaID string `json:"media_id"`
			Key     string `json:"key"`
		}
		if err := readJSON(r, &body); err != nil {
			writeErr(w, err)
			return
		}
		key, err := base64.StdEncoding.DecodeString(body.Key)
		if err != nil || body.MediaID == "" {
			writeErr(w, fmt.Errorf("%w: media_id and key (base64) are needed", ErrBadInput))
			return
		}
		data, err := s.phone(uid).Media(r.Context(), body.MediaID, key)
		if err != nil {
			writeErr(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(data)
	})

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" && !s.authorized(r) {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": map[string]string{"code": "auth", "message": "missing or wrong secret"}})
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "no streaming", 500)
		return
	}
	ch := make(chan Event, 256)
	s.mu.Lock()
	s.subs[ch] = struct{}{}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.subs, ch)
		s.mu.Unlock()
	}()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(200)
	_, _ = fmt.Fprint(w, ": hello\n\n")
	fl.Flush()
	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ping.C:
			_, _ = fmt.Fprint(w, ": ping\n\n")
			fl.Flush()
		case e := <-ch:
			b, _ := json.Marshal(e)
			_, _ = fmt.Fprintf(w, "data: %s\n\n", b)
			fl.Flush()
		}
	}
}

var numberRe = regexp.MustCompile(`^\+?[0-9 ().-]{3,24}$`)

func validNumber(n string) bool { return numberRe.MatchString(n) }
