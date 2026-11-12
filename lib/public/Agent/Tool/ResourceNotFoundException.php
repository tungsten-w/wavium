<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCP\Agent\Tool;

/**
 * The resource does not exist, or the caller may not see it (never reveal which).
 *
 * @since 34.0.5
 */
class ResourceNotFoundException extends AgentToolException {
}
