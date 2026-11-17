// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package main

import (
	"context"
	"encoding/json"
	"errors"
)

// The JSON shapes the Bun server sees. They hide libgm's protobufs so the
// sidecar can be bumped (or replaced) without touching Wavium.

type Participant struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Number string `json:"number"`
	IsMe   bool   `json:"is_me"`
}

type Conversation struct {
	ID           string        `json:"id"`
	Name         string        `json:"name"`
	IsGroup      bool          `json:"is_group"`
	Unread       bool          `json:"unread"`
	LastAt       int64         `json:"last_at"` // unix ms
	Kind         string        `json:"kind"`    // sms | rcs
	ReadOnly     bool          `json:"read_only"`
	OutgoingID   string        `json:"outgoing_id"`
	Participants []Participant `json:"participants"`
}

type Media struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Mime string `json:"mime"`
	Size int64  `json:"size"`
	// Decryption key (base64). Only the sidecar can use it; Bun stores it to fetch later.
	Key string `json:"key"`
}

type Message struct {
	ID             string  `json:"id"`
	ConversationID string  `json:"conversation_id"`
	At             int64   `json:"at"` // unix ms
	FromMe         bool    `json:"from_me"`
	SenderID       string  `json:"sender_id"`
	SenderName     string  `json:"sender_name"`
	SenderNumber   string  `json:"sender_number"`
	Text           string  `json:"text"`
	Status         string  `json:"status"` // received | sending | sent | delivered | read | failed
	Media          []Media `json:"media"`
	TmpID          string  `json:"tmp_id,omitempty"`
}

// Event goes to Bun on the event stream (GET /v1/events).
type Event struct {
	Type string `json:"type"`
	UID  string `json:"uid"`
	// qr: QR code data to show; emoji: the emoji to tap on the phone (Google account pairing)
	QR    string `json:"qr,omitempty"`
	Emoji string `json:"emoji,omitempty"`
	// paired / session: the pairing session to store (encrypted) by Bun
	Session      json.RawMessage `json:"session,omitempty"`
	Phone        string          `json:"phone,omitempty"`
	Message      *Message        `json:"message,omitempty"`
	Conversation *Conversation   `json:"conversation,omitempty"`
	Error        string          `json:"error,omitempty"`
}

type Status struct {
	State string `json:"state"` // unpaired | pairing | connecting | connected | phone_offline | logged_out | error
	QR    string `json:"qr,omitempty"`
	Emoji string `json:"emoji,omitempty"`
	Phone string `json:"phone,omitempty"`
	Error string `json:"error,omitempty"`
}

var (
	ErrNotPaired = errors.New("not paired")
	ErrNotFound  = errors.New("not found")
	ErrBadInput  = errors.New("bad input")
)

// Phone is one user's link to their phone (libgm, or the fake one).
type Phone interface {
	Status() Status
	PairQR(ctx context.Context) (string, error)
	PairGoogle(ctx context.Context, cookies map[string]string) (string, error)
	Connect(ctx context.Context, session json.RawMessage) error
	Unpair(ctx context.Context) error
	Close()
	Conversations(ctx context.Context, count int) ([]Conversation, error)
	Messages(ctx context.Context, conversationID string, count int) ([]Message, error)
	Send(ctx context.Context, conversationID, text, tmpID string) error
	StartConversation(ctx context.Context, number string) (*Conversation, error)
	MarkRead(ctx context.Context, conversationID, messageID string) error
	Media(ctx context.Context, mediaID string, key []byte) ([]byte, error)
}

// Emit sends an event to Bun.
type Emit func(Event)
