<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCP\Agent\Tool;

use OCP\Agent\IAgentContext;

/**
 * An operation that is not plain CRUD (send a mail, postpone a task). Becomes the
 * tool `<app>.<name>`. Resources themselves go through IAgentResourceProvider.
 *
 * Register it in the app's Application::register():
 *   $context->registerAgentActionProvider(MyAction::class);
 *
 * @since 34.0.5
 */
interface IAgentActionProvider {
	/**
	 * @since 34.0.5
	 */
	public function getAppId(): string;

	/**
	 * Action name, lowercase `[a-z][a-z0-9_]*`: `send_message`, `postpone_item`.
	 *
	 * @since 34.0.5
	 */
	public function getName(): string;

	/**
	 * @since 34.0.5
	 */
	public function getScopeArea(): string;

	/**
	 * Scope action required, for example `send` or `write`.
	 *
	 * @since 34.0.5
	 */
	public function getScopeAction(): string;

	/**
	 * @since 34.0.5
	 */
	public function getDescription(): string;

	/**
	 * JSON Schema of the input object.
	 *
	 * @return array<string, mixed>
	 * @since 34.0.5
	 */
	public function getInputSchema(): array;

	/**
	 * Whether a human must approve the call before it runs (sending, sharing
	 * publicly, deleting in bulk). Approvals arrive in phase 3.
	 *
	 * @since 34.0.5
	 */
	public function needsApproval(): bool;

	/**
	 * @param array<string, mixed> $input validated against getInputSchema()
	 * @return array<string, mixed>
	 * @throws InvalidInputException
	 * @throws AgentToolException
	 * @since 34.0.5
	 */
	public function execute(IAgentContext $context, array $input): array;
}
