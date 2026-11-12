<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Boot the real Nextcloud/Atrium instance (dev container) so the tests run
// against the actual database schema and app container.
require_once __DIR__ . '/../../../lib/base.php';
require_once __DIR__ . '/Unit/Atrium/MailDbTestCase.php';
\OC_App::loadApp('mail');
