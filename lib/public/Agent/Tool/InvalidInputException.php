<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCP\Agent\Tool;

/**
 * The input does not match the schema or breaks a rule of the app.
 *
 * @since 34.0.5
 */
class InvalidInputException extends AgentToolException {
}
