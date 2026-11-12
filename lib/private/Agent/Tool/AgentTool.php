<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OC\Agent\Tool;

use OCP\Agent\Tool\IAgentActionProvider;
use OCP\Agent\Tool\IAgentResourceProvider;

/**
 * One tool as transports (MCP, REST) will publish it.
 */
final class AgentTool {
	public const OP_LIST = 'list';
	public const OP_GET = 'get';
	public const OP_CREATE = 'create';
	public const OP_UPDATE = 'update';
	public const OP_DELETE = 'delete';
	public const OP_ACTION = 'action';

	public const CRUD = [self::OP_LIST, self::OP_GET, self::OP_CREATE, self::OP_UPDATE, self::OP_DELETE];

	/**
	 * @param array<string, mixed> $inputSchema
	 */
	public function __construct(
		public readonly string $name,
		public readonly string $appId,
		public readonly string $operation,
		public readonly string $description,
		public readonly array $inputSchema,
		public readonly string $scopeArea,
		public readonly string $scopeAction,
		public readonly bool $needsApproval,
		public readonly IAgentResourceProvider|IAgentActionProvider $provider,
	) {
	}

	public function getScope(): string {
		return $this->scopeArea . ':' . $this->scopeAction;
	}

	/**
	 * @return array{name: string, description: string, inputSchema: array<string, mixed>}
	 */
	public function toMcp(): array {
		return [
			'name' => $this->name,
			'description' => $this->description,
			'inputSchema' => $this->inputSchema,
		];
	}
}
