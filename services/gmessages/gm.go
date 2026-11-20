// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"
	"go.mau.fi/util/exhttp"

	"go.mau.fi/mautrix-gmessages/pkg/libgm"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/events"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/gmproto"
)

// GMPhone: the real link, through libgm (the same protocol as
// messages.google.com/web). One per Wavium user.
type GMPhone struct {
	emit Emit
	log  zerolog.Logger

	mu     sync.Mutex
	client *libgm.Client
	state  string
	qr     string
	emoji  string
	phone  string
	errMsg string
	cancel context.CancelFunc
}

func NewGMPhone(emit Emit, log zerolog.Logger) *GMPhone {
	return &GMPhone{emit: emit, log: log, state: "unpaired"}
}

func (g *GMPhone) Status() Status {
	g.mu.Lock()
	defer g.mu.Unlock()
	return Status{State: g.state, QR: g.qr, Emoji: g.emoji, Phone: g.phone, Error: g.errMsg}
}

func (g *GMPhone) set(state string) {
	g.mu.Lock()
	g.state = state
	g.mu.Unlock()
}

func (g *GMPhone) session() json.RawMessage {
	g.mu.Lock()
	c := g.client
	g.mu.Unlock()
	if c == nil {
		return nil
	}
	b, err := json.Marshal(c.AuthData)
	if err != nil {
		return nil
	}
	return b
}

func (g *GMPhone) newClient(ad *libgm.AuthData) *libgm.Client {
	c := libgm.NewClient(ad, nil, g.log, exhttp.SensibleClientSettings)
	c.SetEventHandler(g.handle)
	return c
}

// handle runs synchronously inside libgm: no blocking calls here.
func (g *GMPhone) handle(evt any) {
	switch e := evt.(type) {
	case *events.PairSuccessful:
		g.mu.Lock()
		g.state, g.qr, g.emoji = "connecting", "", ""
		g.phone = e.PhoneID
		if g.cancel != nil {
			g.cancel()
			g.cancel = nil
		}
		g.mu.Unlock()
		go func() {
			// libgm reconnects by itself after a QR pairing; the session is final now.
			g.emit(Event{Type: "paired", Session: g.session(), Phone: e.PhoneID})
		}()
	case *events.ClientReady:
		g.set("connected")
		for _, c := range e.Conversations {
			conv := convertConversation(c)
			g.emit(Event{Type: "conversation", Conversation: &conv})
		}
	case *events.AuthTokenRefreshed:
		go func() { g.emit(Event{Type: "session", Session: g.session()}) }()
	case *events.PhoneNotResponding:
		g.set("phone_offline")
		g.emit(Event{Type: "phone_offline"})
	case *events.PhoneRespondingAgain:
		g.set("connected")
		g.emit(Event{Type: "phone_online"})
	case *events.ListenRecovered:
		g.set("connected")
	case *gmproto.RevokePairData, *events.GaiaLoggedOut:
		g.set("logged_out")
		g.emit(Event{Type: "logged_out"})
	case *events.ListenFatalError:
		g.mu.Lock()
		g.state, g.errMsg = "error", e.Error.Error()
		g.mu.Unlock()
		g.emit(Event{Type: "logged_out", Error: e.Error.Error()})
	case *gmproto.Conversation:
		conv := convertConversation(e)
		g.emit(Event{Type: "conversation", Conversation: &conv})
	case *libgm.WrappedMessage:
		m := convertMessage(e.Message)
		g.emit(Event{Type: "message", Message: &m})
	}
}

func (g *GMPhone) PairQR(ctx context.Context) (string, error) {
	c := g.newClient(libgm.NewAuthData())
	if err := c.FetchConfig(ctx); err != nil {
		return "", fmt.Errorf("google messages config: %w", err)
	}
	bg, cancel := context.WithCancel(context.Background())
	qr, err := c.StartLogin(bg)
	if err != nil {
		cancel()
		return "", fmt.Errorf("start pairing: %w", err)
	}
	g.mu.Lock()
	g.client, g.state, g.qr, g.cancel = c, "pairing", qr, cancel
	g.mu.Unlock()
	// A QR code lives 30 s: refresh it a few times, then give up.
	go func() {
		for i := 0; i < 6; i++ {
			select {
			case <-bg.Done():
				return
			case <-time.After(30 * time.Second):
			}
			if g.Status().State != "pairing" {
				return
			}
			next, err := c.RefreshPhoneRelay()
			if err != nil {
				break
			}
			g.mu.Lock()
			g.qr = next
			g.mu.Unlock()
			g.emit(Event{Type: "qr", QR: next})
		}
		if g.Status().State == "pairing" {
			g.mu.Lock()
			g.state, g.qr = "unpaired", ""
			g.mu.Unlock()
			c.Disconnect()
			g.emit(Event{Type: "pair_failed", Error: "The QR code was not scanned in time"})
		}
	}()
	return qr, nil
}

func (g *GMPhone) PairGoogle(ctx context.Context, cookies map[string]string) (string, error) {
	ad := libgm.NewAuthData()
	ad.SetCookies(cookies)
	c := g.newClient(ad)
	if err := c.FetchConfig(ctx); err != nil {
		return "", fmt.Errorf("google messages config: %w", err)
	}
	bg, cancel := context.WithCancel(context.Background())
	emoji, sess, err := c.StartGaiaPairing(ctx, bg)
	if err != nil {
		cancel()
		c.Disconnect()
		return "", fmt.Errorf("google account pairing: %w", err)
	}
	g.mu.Lock()
	g.client, g.state, g.emoji, g.cancel = c, "pairing", emoji, cancel
	g.mu.Unlock()
	go func() {
		phoneID, err := c.FinishGaiaPairing(bg, sess)
		if err != nil {
			g.mu.Lock()
			g.state, g.emoji = "unpaired", ""
			g.mu.Unlock()
			c.Disconnect()
			g.emit(Event{Type: "pair_failed", Error: err.Error()})
			return
		}
		g.handle(&events.PairSuccessful{PhoneID: phoneID})
		if err := c.Reconnect(context.Background()); err != nil {
			g.log.Err(err).Msg("reconnect after google pairing")
		}
	}()
	return emoji, nil
}

func (g *GMPhone) Connect(ctx context.Context, session json.RawMessage) error {
	ad := libgm.NewAuthData()
	if err := json.Unmarshal(session, ad); err != nil {
		return fmt.Errorf("%w: session is not valid JSON", ErrBadInput)
	}
	c := g.newClient(ad)
	g.mu.Lock()
	g.client, g.state = c, "connecting"
	g.mu.Unlock()
	if err := c.Connect(context.Background()); err != nil {
		g.mu.Lock()
		g.state, g.errMsg = "error", err.Error()
		g.mu.Unlock()
		return err
	}
	return nil
}

func (g *GMPhone) Unpair(ctx context.Context) error {
	c, err := g.connected()
	if err != nil {
		return err
	}
	return c.Unpair(ctx)
}

func (g *GMPhone) Close() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.cancel != nil {
		g.cancel()
	}
	if g.client != nil {
		g.client.Disconnect()
	}
}

func (g *GMPhone) connected() (*libgm.Client, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.client == nil || g.state == "unpaired" || g.state == "pairing" || g.state == "logged_out" {
		return nil, ErrNotPaired
	}
	return g.client, nil
}

func (g *GMPhone) Conversations(ctx context.Context, n int) ([]Conversation, error) {
	c, err := g.connected()
	if err != nil {
		return nil, err
	}
	res, err := c.ListConversations(ctx, &gmproto.ListConversationsRequest{Count: int64(n), Folder: gmproto.ListConversationsRequest_INBOX})
	if err != nil {
		return nil, err
	}
	out := make([]Conversation, 0, len(res.GetConversations()))
	for _, x := range res.GetConversations() {
		out = append(out, convertConversation(x))
	}
	return out, nil
}

func (g *GMPhone) Messages(ctx context.Context, cid string, n int) ([]Message, error) {
	c, err := g.connected()
	if err != nil {
		return nil, err
	}
	res, err := c.FetchMessages(ctx, cid, int64(n), nil)
	if err != nil {
		return nil, err
	}
	out := make([]Message, 0, len(res.GetMessages()))
	for _, x := range res.GetMessages() {
		out = append(out, convertMessage(x))
	}
	return out, nil
}

func (g *GMPhone) Send(ctx context.Context, cid, text, tmpID string) error {
	c, err := g.connected()
	if err != nil {
		return err
	}
	conv, err := c.GetConversation(ctx, cid)
	if err != nil {
		return err
	}
	var sim *gmproto.SIMPayload
	for _, p := range conv.GetParticipants() {
		if p.GetIsMe() && p.GetID().GetParticipantID() == conv.GetDefaultOutgoingID() {
			sim = p.GetSimPayload()
		}
	}
	res, err := c.SendMessage(ctx, &gmproto.SendMessageRequest{
		ConversationID: cid,
		MessagePayload: &gmproto.MessagePayload{
			TmpID:          tmpID,
			ConversationID: cid,
			ParticipantID:  conv.GetDefaultOutgoingID(),
			TmpID2:         tmpID,
			MessageInfo: []*gmproto.MessageInfo{{Data: &gmproto.MessageInfo_MessageContent{
				MessageContent: &gmproto.MessageContent{Content: text},
			}}},
		},
		SIMPayload: sim,
		TmpID:      tmpID,
	})
	if err != nil {
		return err
	}
	if res.GetStatus() != gmproto.SendMessageResponse_SUCCESS {
		return fmt.Errorf("the phone refused the message (%s)", res.GetStatus())
	}
	return nil
}

func (g *GMPhone) StartConversation(ctx context.Context, number string) (*Conversation, error) {
	c, err := g.connected()
	if err != nil {
		return nil, err
	}
	res, err := c.GetOrCreateConversation(ctx, &gmproto.GetOrCreateConversationRequest{
		Numbers: []*gmproto.ContactNumber{{MysteriousInt: 2, Number: number, Number2: number}},
	})
	if err != nil {
		return nil, err
	}
	if res.GetConversation() == nil {
		return nil, fmt.Errorf("the phone did not open a conversation (%s)", res.GetStatus())
	}
	conv := convertConversation(res.GetConversation())
	return &conv, nil
}

func (g *GMPhone) MarkRead(ctx context.Context, cid, mid string) error {
	c, err := g.connected()
	if err != nil {
		return err
	}
	return c.MarkRead(ctx, cid, mid)
}

func (g *GMPhone) Media(ctx context.Context, mediaID string, key []byte) ([]byte, error) {
	c, err := g.connected()
	if err != nil {
		return nil, err
	}
	r, err := c.DownloadMedia(mediaID, key)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return io.ReadAll(io.LimitReader(r, 100<<20))
}

// --- protobuf -> Wavium JSON ------------------------------------------------

func convertConversation(c *gmproto.Conversation) Conversation {
	out := Conversation{
		ID: c.GetConversationID(), Name: c.GetName(), IsGroup: c.GetIsGroupChat(), Unread: c.GetUnread(),
		LastAt: c.GetLastMessageTimestamp() / 1000, ReadOnly: c.GetReadOnly(), OutgoingID: c.GetDefaultOutgoingID(),
		Kind: "sms", Participants: []Participant{},
	}
	if c.GetType() == gmproto.ConversationType_RCS {
		out.Kind = "rcs"
	}
	for _, p := range c.GetParticipants() {
		out.Participants = append(out.Participants, Participant{
			ID: p.GetID().GetParticipantID(), Name: firstNonEmpty(p.GetFullName(), p.GetFirstName()),
			Number: firstNonEmpty(p.GetID().GetNumber(), p.GetFormattedNumber()), IsMe: p.GetIsMe(),
		})
	}
	return out
}

func convertMessage(m *gmproto.Message) Message {
	st := m.GetMessageStatus().GetStatus()
	out := Message{
		ID: m.GetMessageID(), ConversationID: m.GetConversationID(), At: m.GetTimestamp() / 1000,
		SenderID: m.GetParticipantID(), TmpID: m.GetTmpID(), Status: statusName(st), Media: []Media{},
	}
	out.FromMe = st != 0 && st < gmproto.MessageStatusType_INCOMING_COMPLETE
	if sp := m.GetSenderParticipant(); sp != nil {
		out.FromMe = out.FromMe || sp.GetIsMe()
		out.SenderName = firstNonEmpty(sp.GetFullName(), sp.GetFirstName())
		out.SenderNumber = firstNonEmpty(sp.GetID().GetNumber(), sp.GetFormattedNumber())
	}
	var text []string
	for _, info := range m.GetMessageInfo() {
		if mc := info.GetMessageContent(); mc != nil && mc.GetContent() != "" {
			text = append(text, mc.GetContent())
		}
		if md := info.GetMediaContent(); md != nil {
			out.Media = append(out.Media, Media{
				ID: md.GetMediaID(), Name: md.GetMediaName(), Mime: md.GetMimeType(), Size: md.GetSize(),
				Key: base64.StdEncoding.EncodeToString(md.GetDecryptionKey()),
			})
		}
	}
	out.Text = strings.Join(text, "\n")
	return out
}

func statusName(st gmproto.MessageStatusType) string {
	name := st.String()
	switch {
	case st == 0:
		return "received"
	case strings.HasPrefix(name, "INCOMING"):
		return "received"
	case st == gmproto.MessageStatusType_OUTGOING_DISPLAYED:
		return "read"
	case st == gmproto.MessageStatusType_OUTGOING_DELIVERED:
		return "delivered"
	case st == gmproto.MessageStatusType_OUTGOING_COMPLETE:
		return "sent"
	case strings.Contains(name, "FAILED") || st == gmproto.MessageStatusType_OUTGOING_CANCELED:
		return "failed"
	case strings.HasPrefix(name, "OUTGOING"):
		return "sending"
	}
	return "received"
}

func firstNonEmpty(xs ...string) string {
	for _, x := range xs {
		if x != "" {
			return x
		}
	}
	return ""
}
