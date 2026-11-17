// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// FakePhone: a phone that lives in memory (GMESSAGES_FAKE=1), for tests, the
// dev stack and end-to-end runs. Pairing "scans" itself after PairDelay;
// every message sent gets an automatic answer after ReplyDelay.
type FakePhone struct {
	emit       Emit
	PairDelay  time.Duration
	ReplyDelay time.Duration

	mu     sync.Mutex
	state  string
	qr     string
	emoji  string
	convs  map[string]*Conversation
	msgs   map[string][]Message
	nextID int
	timers []*time.Timer
}

func NewFakePhone(emit Emit) *FakePhone {
	return &FakePhone{emit: emit, state: "unpaired", PairDelay: 3 * time.Second, ReplyDelay: 2 * time.Second}
}

const fakeSession = `{"fake":true,"phone":"Pixel (fake)"}`

func (f *FakePhone) after(d time.Duration, fn func()) {
	f.timers = append(f.timers, time.AfterFunc(d, fn))
}

func (f *FakePhone) Status() Status {
	f.mu.Lock()
	defer f.mu.Unlock()
	st := Status{State: f.state, QR: f.qr, Emoji: f.emoji}
	if f.state == "connected" {
		st.Phone = "Pixel (fake)"
	}
	return st
}

func (f *FakePhone) paired() {
	f.mu.Lock()
	if f.state != "pairing" {
		f.mu.Unlock()
		return
	}
	f.state, f.qr, f.emoji = "connected", "", ""
	f.seed()
	f.mu.Unlock()
	f.emit(Event{Type: "paired", Session: json.RawMessage(fakeSession), Phone: "Pixel (fake)"})
}

func (f *FakePhone) PairQR(ctx context.Context) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.state = "pairing"
	f.qr = "https://support.google.com/messages/?p=web_computer#?c=FAKE-WAVIUM-PAIRING"
	f.after(f.PairDelay, f.paired)
	return f.qr, nil
}

func (f *FakePhone) PairGoogle(ctx context.Context, cookies map[string]string) (string, error) {
	if cookies["SAPISID"] == "" {
		return "", fmt.Errorf("%w: the SAPISID cookie is missing", ErrBadInput)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.state = "pairing"
	f.emoji = "🦊"
	f.after(f.PairDelay, f.paired)
	return f.emoji, nil
}

func (f *FakePhone) Connect(ctx context.Context, session json.RawMessage) error {
	var s struct {
		Fake bool `json:"fake"`
	}
	if json.Unmarshal(session, &s) != nil || !s.Fake {
		return fmt.Errorf("%w: not a fake session", ErrBadInput)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.state = "connected"
	f.seed()
	return nil
}

func (f *FakePhone) Unpair(ctx context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.state != "connected" {
		return ErrNotPaired
	}
	f.state = "unpaired"
	f.convs, f.msgs = nil, nil
	return nil
}

func (f *FakePhone) Close() {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, t := range f.timers {
		t.Stop()
	}
}

// seed fills the fake phone (mu held).
func (f *FakePhone) seed() {
	if f.convs != nil {
		return
	}
	f.convs = map[string]*Conversation{}
	f.msgs = map[string][]Message{}
	now := time.Now().UnixMilli()
	add := func(id, name, number string, lines ...string) {
		c := &Conversation{ID: id, Name: name, Kind: "rcs", OutgoingID: "me", Participants: []Participant{
			{ID: "me", Name: "Me", IsMe: true}, {ID: "p" + id, Name: name, Number: number},
		}}
		for i, l := range lines {
			fromMe := strings.HasPrefix(l, "> ")
			m := Message{ID: fmt.Sprintf("%s-%d", id, i), ConversationID: id, At: now - int64(len(lines)-i)*600_000, FromMe: fromMe, Text: strings.TrimPrefix(l, "> ")}
			if fromMe {
				m.SenderID, m.Status = "me", "read"
			} else {
				m.SenderID, m.SenderName, m.SenderNumber, m.Status = "p"+id, name, number, "received"
			}
			f.msgs[id] = append(f.msgs[id], m)
			c.LastAt = m.At
			c.Unread = !fromMe
		}
		f.convs[id] = c
	}
	add("c1", "Maman", "+33612345678", "Tu passes dimanche ?", "> Oui vers midi", "Super, je fais un gâteau")
	add("c2", "Bank", "38015", "Your code is 482913. Never share it.")
	add("c3", "Léa", "+33698765432", "On se voit au café demain 9h ?")
}

func (f *FakePhone) needPaired() error {
	if f.state != "connected" {
		return ErrNotPaired
	}
	return nil
}

func (f *FakePhone) Conversations(ctx context.Context, n int) ([]Conversation, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.needPaired(); err != nil {
		return nil, err
	}
	out := make([]Conversation, 0, len(f.convs))
	for _, c := range f.convs {
		out = append(out, *c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].LastAt > out[j].LastAt })
	if len(out) > n {
		out = out[:n]
	}
	return out, nil
}

func (f *FakePhone) Messages(ctx context.Context, cid string, n int) ([]Message, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.needPaired(); err != nil {
		return nil, err
	}
	ms, ok := f.msgs[cid]
	if !ok {
		return nil, ErrNotFound
	}
	if len(ms) > n {
		ms = ms[len(ms)-n:]
	}
	return append([]Message(nil), ms...), nil
}

func (f *FakePhone) Send(ctx context.Context, cid, text, tmpID string) error {
	f.mu.Lock()
	if err := f.needPaired(); err != nil {
		f.mu.Unlock()
		return err
	}
	c, ok := f.convs[cid]
	if !ok {
		f.mu.Unlock()
		return ErrNotFound
	}
	f.nextID++
	m := Message{ID: fmt.Sprintf("s%d", f.nextID), ConversationID: cid, At: time.Now().UnixMilli(), FromMe: true, SenderID: "me", Text: text, Status: "sent", TmpID: tmpID}
	f.msgs[cid] = append(f.msgs[cid], m)
	c.LastAt, c.Unread = m.At, false
	other := c.Participants[len(c.Participants)-1]
	f.after(f.ReplyDelay, func() {
		f.mu.Lock()
		f.nextID++
		r := Message{ID: fmt.Sprintf("r%d", f.nextID), ConversationID: cid, At: time.Now().UnixMilli(), SenderID: other.ID, SenderName: other.Name, SenderNumber: other.Number, Text: "👍 (fake phone)", Status: "received"}
		f.msgs[cid] = append(f.msgs[cid], r)
		c.LastAt, c.Unread = r.At, true
		cc := *c
		f.mu.Unlock()
		f.emit(Event{Type: "message", Message: &r, Conversation: &cc})
	})
	cc := *c
	f.mu.Unlock()
	f.emit(Event{Type: "message", Message: &m, Conversation: &cc})
	return nil
}

func (f *FakePhone) StartConversation(ctx context.Context, number string) (*Conversation, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.needPaired(); err != nil {
		return nil, err
	}
	for _, c := range f.convs {
		if len(c.Participants) == 2 && c.Participants[1].Number == number {
			cc := *c
			return &cc, nil
		}
	}
	f.nextID++
	id := fmt.Sprintf("n%d", f.nextID)
	c := &Conversation{ID: id, Name: number, Kind: "sms", OutgoingID: "me", LastAt: time.Now().UnixMilli(), Participants: []Participant{{ID: "me", IsMe: true}, {ID: "p" + id, Name: number, Number: number}}}
	f.convs[id] = c
	f.msgs[id] = nil
	cc := *c
	return &cc, nil
}

func (f *FakePhone) MarkRead(ctx context.Context, cid, mid string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.needPaired(); err != nil {
		return err
	}
	c, ok := f.convs[cid]
	if !ok {
		return ErrNotFound
	}
	c.Unread = false
	return nil
}

func (f *FakePhone) Media(ctx context.Context, mediaID string, key []byte) ([]byte, error) {
	return nil, ErrNotFound
}
