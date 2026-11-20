// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package main

import (
	"bufio"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.mau.fi/mautrix-gmessages/pkg/libgm/gmproto"
)

const secret = "0123456789abcdef0123456789abcdef"

func fakeServer(t *testing.T) *httptest.Server {
	s := NewServer(secret, func(uid string, emit Emit) Phone {
		f := NewFakePhone(emit)
		f.PairDelay = 20 * time.Millisecond
		f.ReplyDelay = 20 * time.Millisecond
		return f
	})
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return ts
}

func call(t *testing.T, ts *httptest.Server, method, path, body string, auth bool) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
	if auth {
		req.Header.Set("Authorization", "Bearer "+secret)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func TestSecretRequired(t *testing.T) {
	ts := fakeServer(t)
	for _, p := range []string{"/v1/users/alice/status", "/v1/events", "/v1/users/alice/conversations"} {
		if code, _ := call(t, ts, "GET", p, "", false); code != 401 {
			t.Fatalf("%s without secret: %d", p, code)
		}
	}
	req, _ := http.NewRequest("GET", ts.URL+"/v1/users/alice/status", nil)
	req.Header.Set("Authorization", "Bearer "+secret[:31]+"X")
	res, _ := http.DefaultClient.Do(req)
	if res.StatusCode != 401 {
		t.Fatalf("wrong secret: %d", res.StatusCode)
	}
	if code, _ := call(t, ts, "GET", "/healthz", "", false); code != 200 {
		t.Fatalf("healthz: %d", code)
	}
}

func TestBadUserID(t *testing.T) {
	ts := fakeServer(t)
	if code, _ := call(t, ts, "GET", "/v1/users/a%20b/status", "", true); code != 400 {
		t.Fatalf("bad uid: %d", code)
	}
}

func TestPairSendAndEvents(t *testing.T) {
	ts := fakeServer(t)
	// Listen to events first.
	req, _ := http.NewRequest("GET", ts.URL+"/v1/events", nil)
	req.Header.Set("Authorization", "Bearer "+secret)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	evs := make(chan Event, 20)
	go func() {
		sc := bufio.NewScanner(res.Body)
		for sc.Scan() {
			if line := sc.Text(); strings.HasPrefix(line, "data: ") {
				var e Event
				_ = json.Unmarshal([]byte(line[6:]), &e)
				evs <- e
			}
		}
	}()
	wait := func(typ string) Event {
		t.Helper()
		for {
			select {
			case e := <-evs:
				if e.Type == typ {
					return e
				}
			case <-time.After(2 * time.Second):
				t.Fatalf("no %s event", typ)
			}
		}
	}

	if code, out := call(t, ts, "GET", "/v1/users/alice/conversations", "", true); code != 409 || out["error"].(map[string]any)["code"] != "not_paired" {
		t.Fatalf("before pairing: %d %v", code, out)
	}
	code, out := call(t, ts, "POST", "/v1/users/alice/pair/qr", "", true)
	if code != 200 || out["qr"] == "" {
		t.Fatalf("pair: %d %v", code, out)
	}
	paired := wait("paired")
	if paired.UID != "alice" || len(paired.Session) == 0 {
		t.Fatalf("paired event: %+v", paired)
	}
	code, out = call(t, ts, "GET", "/v1/users/alice/conversations", "", true)
	if code != 200 || len(out["conversations"].([]any)) != 3 {
		t.Fatalf("conversations: %d %v", code, out)
	}
	if code, _ := call(t, ts, "POST", "/v1/users/alice/send", `{"conversation_id":"c1","text":"hello"}`, true); code != 400 {
		t.Fatalf("send without tmp_id: %d", code)
	}
	if code, _ := call(t, ts, "POST", "/v1/users/alice/send", `{"conversation_id":"c1","text":"hello","tmp_id":"t1"}`, true); code != 200 {
		t.Fatalf("send: %d", code)
	}
	sent := wait("message")
	if !sent.Message.FromMe || sent.Message.TmpID != "t1" {
		t.Fatalf("sent echo: %+v", sent.Message)
	}
	reply := wait("message")
	if reply.Message.FromMe {
		t.Fatalf("reply: %+v", reply.Message)
	}
	// Bob is another phone: alice's pairing is not his.
	if code, _ := call(t, ts, "GET", "/v1/users/bob/conversations", "", true); code != 409 {
		t.Fatalf("bob sees alice's phone: %d", code)
	}
	// A stored session reconnects; unpair forgets it.
	if code, out := call(t, ts, "PUT", "/v1/users/bob/session", `{"session":`+fakeSession+`}`, true); code != 200 || out["state"] != "connected" {
		t.Fatalf("connect: %d %v", code, out)
	}
	if code, _ := call(t, ts, "DELETE", "/v1/users/bob/session", "", true); code != 200 {
		t.Fatalf("unpair: %d", code)
	}
	if code, _ := call(t, ts, "GET", "/v1/users/bob/conversations", "", true); code != 409 {
		t.Fatalf("after unpair: %d", code)
	}
}

func TestStartConversationValidatesNumber(t *testing.T) {
	ts := fakeServer(t)
	call(t, ts, "PUT", "/v1/users/alice/session", `{"session":`+fakeSession+`}`, true)
	if code, _ := call(t, ts, "POST", "/v1/users/alice/conversations", `{"number":"; rm -rf /"}`, true); code != 400 {
		t.Fatalf("bad number: %d", code)
	}
	code, out := call(t, ts, "POST", "/v1/users/alice/conversations", `{"number":"+33 6 11 22 33 44"}`, true)
	if code != 200 || out["id"] == "" {
		t.Fatalf("start: %d %v", code, out)
	}
}

func TestBodyLimit(t *testing.T) {
	ts := fakeServer(t)
	big := `{"session":"` + strings.Repeat("a", 2<<20) + `"}`
	if code, _ := call(t, ts, "PUT", "/v1/users/alice/session", big, true); code != 400 {
		t.Fatalf("2 MB body: %d", code)
	}
}

func TestConvertMessage(t *testing.T) {
	m := &gmproto.Message{
		MessageID: "m1", ConversationID: "c1", Timestamp: 1_700_000_000_000_000, ParticipantID: "p2",
		MessageStatus: &gmproto.MessageStatus{Status: gmproto.MessageStatusType_INCOMING_COMPLETE},
		MessageInfo: []*gmproto.MessageInfo{
			{Data: &gmproto.MessageInfo_MessageContent{MessageContent: &gmproto.MessageContent{Content: "Salut"}}},
			{Data: &gmproto.MessageInfo_MediaContent{MediaContent: &gmproto.MediaContent{MediaID: "md", MimeType: "image/jpeg", DecryptionKey: []byte{1, 2}}}},
		},
		SenderParticipant: &gmproto.Participant{FullName: "Léa", ID: &gmproto.SmallInfo{Number: "+336"}},
	}
	out := convertMessage(m)
	if out.FromMe || out.Text != "Salut" || out.At != 1_700_000_000_000 || out.SenderName != "Léa" || out.Status != "received" {
		t.Fatalf("incoming: %+v", out)
	}
	if len(out.Media) != 1 || out.Media[0].Key != "AQI=" {
		t.Fatalf("media: %+v", out.Media)
	}
	m.MessageStatus.Status = gmproto.MessageStatusType_OUTGOING_FAILED_GENERIC
	if o := convertMessage(m); !o.FromMe || o.Status != "failed" {
		t.Fatalf("failed outgoing: %+v", o)
	}
	m.MessageStatus.Status = gmproto.MessageStatusType_OUTGOING_DISPLAYED
	if o := convertMessage(m); o.Status != "read" {
		t.Fatalf("displayed: %+v", o)
	}
}

func TestConvertConversation(t *testing.T) {
	c := convertConversation(&gmproto.Conversation{
		ConversationID: "c1", Name: "Maman", Type: gmproto.ConversationType_RCS, LastMessageTimestamp: 2_000_000,
		Participants: []*gmproto.Participant{{IsMe: true, ID: &gmproto.SmallInfo{ParticipantID: "1"}}, {FullName: "Maman", ID: &gmproto.SmallInfo{ParticipantID: "2", Number: "+33"}}},
	})
	if c.Kind != "rcs" || c.LastAt != 2000 || len(c.Participants) != 2 || !c.Participants[0].IsMe || c.Participants[1].Number != "+33" {
		t.Fatalf("%+v", c)
	}
}
