<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCP\Agent\Tool;

/**
 * A tool call failed. The message is shown to the agent, so keep it short and
 * actionable and never put secrets in it.
 *
 * @since 34.0.5
 */
class AgentToolException extends \Exception {
}
