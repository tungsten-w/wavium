// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Command gmessages: Wavium's link to Google Messages (ADR 0010). A small HTTP
// service on the internal Docker network, only for the Bun server.
//
//	GMESSAGES_SECRET   shared secret (required, 32+ characters)
//	GMESSAGES_LISTEN   address (default :8765)
//	GMESSAGES_FAKE=1   in-memory fake phone (tests, dev, demo)
package main

import (
	"log"
	"net/http"
	"os"
	"time"

	"github.com/rs/zerolog"
)

func main() {
	secret := os.Getenv("GMESSAGES_SECRET")
	if len(secret) < 32 {
		log.Fatal("GMESSAGES_SECRET must be set (32+ characters)")
	}
	addr := os.Getenv("GMESSAGES_LISTEN")
	if addr == "" {
		addr = ":8765"
	}
	fake := os.Getenv("GMESSAGES_FAKE") == "1"
	// libgm logs warnings and errors only, never message contents (they are at debug level).
	zl := zerolog.New(os.Stderr).Level(zerolog.WarnLevel).With().Timestamp().Str("component", "libgm").Logger()
	srv := NewServer(secret, func(uid string, emit Emit) Phone {
		if fake {
			return NewFakePhone(emit)
		}
		return NewGMPhone(emit, zl.With().Str("user", uid).Logger())
	})
	h := &http.Server{Addr: addr, Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}
	mode := "google messages"
	if fake {
		mode = "fake phone"
	}
	log.Printf("gmessages: %s on %s", mode, addr)
	log.Fatal(h.ListenAndServe())
}
