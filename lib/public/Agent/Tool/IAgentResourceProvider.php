<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCP\Agent\Tool;

use OCP\Agent\IAgentContext;

/**
 * One kind of resource an app exposes to agents, with full CRUD.
 *
 * Core turns each provider into five tools, `<app>.<resource>.<operation>`, served
 * over MCP and REST. All five operations are mandatory: an app cannot expose a
 * resource read-only or partially. See docs/architecture/0005-agent-tools.md.
 *
 * Register it in the app's Application::register():
 *   $context->registerAgentResourceProvider(MyProvider::class);
 *
 * Resources are plain arrays matching getSchema(), and always carry a string `id`.
 *
 * @since 34.0.5
 */
interface IAgentResourceProvider {
	/**
	 * Id of the app that owns the resource. Must be the registering app.
	 *
	 * @since 34.0.5
	 */
	public function getAppId(): string;

	/**
	 * Resource name, lowercase `[a-z][a-z0-9_]*`, singular: `contact`, `event`, `board`.
	 *
	 * @since 34.0.5
	 */
	public function getResourceName(): string;

	/**
	 * Scope area that guards the resource (`contacts`, `calendar`, ...). Reads need
	 * `<area>:read`, create/update `<area>:write`, delete `<area>:delete`.
	 *
	 * @since 34.0.5
	 */
	public function getScopeArea(): string;

	/**
	 * One or two sentences for the agent: what the resource is and when to use it.
	 *
	 * @since 34.0.5
	 */
	public function getDescription(): string;

	/**
	 * JSON Schema (draft 2020-12) of one resource, as a PHP array. Must be an object
	 * schema whose properties include `id`. Properties marked `readOnly` are not
	 * accepted on create/update.
	 *
	 * @return array<string, mixed>
	 * @since 34.0.5
	 */
	public function getSchema(): array;

	/**
	 * JSON Schema of the filters list() accepts (an object schema), or `[]` for none.
	 *
	 * @return array<string, mixed>
	 * @since 34.0.5
	 */
	public function getListFilterSchema(): array;

	/**
	 * @param array<string, mixed> $filter validated against getListFilterSchema()
	 * @param int $limit 1..200
	 * @param ?string $cursor opaque value from a previous ResourcePage, or null
	 * @throws AgentToolException
	 * @since 34.0.5
	 */
	public function list(IAgentContext $context, array $filter, int $limit, ?string $cursor): ResourcePage;

	/**
	 * @return array<string, mixed>
	 * @throws ResourceNotFoundException
	 * @throws AgentToolException
	 * @since 34.0.5
	 */
	public function get(IAgentContext $context, string $id): array;

	/**
	 * @param array<string, mixed> $data writable properties
	 * @return array<string, mixed> the created resource, including its id
	 * @throws InvalidInputException
	 * @throws AgentToolException
	 * @since 34.0.5
	 */
	public function create(IAgentContext $context, array $data): array;

	/**
	 * Partial update: only the given properties change.
	 *
	 * @param array<string, mixed> $data writable properties
	 * @return array<string, mixed> the updated resource
	 * @throws ResourceNotFoundException
	 * @throws InvalidInputException
	 * @throws AgentToolException
	 * @since 34.0.5
	 */
	public function update(IAgentContext $context, string $id, array $data): array;

	/**
	 * @throws ResourceNotFoundException
	 * @throws AgentToolException
	 * @since 34.0.5
	 */
	public function delete(IAgentContext $context, string $id): void;
}
