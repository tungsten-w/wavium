<?php

declare(strict_types=1);

// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

namespace OCA\Calendar\Service;

/** An agent-layer error with the HTTP status the internal controller answers. */
final class AtriumAgentError extends \RuntimeException
{
    public function __construct(public readonly int $status, string $message)
    {
        parent::__construct($message);
    }
}
