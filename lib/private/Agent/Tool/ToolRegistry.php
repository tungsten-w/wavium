<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OC\Agent\Tool;

use OC\AppFramework\Bootstrap\Coordinator;
use OCP\Agent\Tool\IAgentActionProvider;
use OCP\Agent\Tool\IAgentResourceProvider;
use OCP\App\IAppManager;
use OCP\Authentication\Scope\IScopeRegistry;
use Psr\Container\ContainerInterface;
use Psr\Log\LoggerInterface;

/**
 * Builds the agent tool list from the providers registered by enabled apps.
 *
 * Every resource provider yields five CRUD tools; every action provider one tool.
 * Invalid or duplicate providers are skipped and logged, so one broken app cannot
 * take the whole tool list down. Calling tools (with grant checks) is phase 3.
 */
class ToolRegistry {
	private const NAME = '/^[a-z][a-z0-9_]{0,63}$/';
	private const APP_ID = '/^[a-z0-9_]{1,64}$/';
	private const FORBIDDEN_AREAS = [IScopeRegistry::AREA_ADMIN, IScopeRegistry::AREA_SECURITY];

	/** @var array<string, AgentTool>|null */
	private ?array $tools = null;

	public function __construct(
		private Coordinator $coordinator,
		private ContainerInterface $container,
		private IAppManager $appManager,
		private LoggerInterface $logger,
	) {
	}

	/**
	 * @return array<string, AgentTool> keyed and sorted by tool name
	 */
	public function getTools(): array {
		if ($this->tools !== null) {
			return $this->tools;
		}
		$tools = [];
		$context = $this->coordinator->getRegistrationContext();
		if ($context !== null) {
			foreach ($context->getAgentResourceProviders() as $registration) {
				$appId = $registration->getAppId();
				$provider = $this->resolve($appId, $registration->getService(), IAgentResourceProvider::class);
				if ($provider !== null) {
					$this->addAll($tools, $appId, fn () => $this->resourceTools($appId, $provider));
				}
			}
			foreach ($context->getAgentActionProviders() as $registration) {
				$appId = $registration->getAppId();
				$provider = $this->resolve($appId, $registration->getService(), IAgentActionProvider::class);
				if ($provider !== null) {
					$this->addAll($tools, $appId, fn () => $this->actionTools($appId, $provider));
				}
			}
		}
		ksort($tools);
		return $this->tools = $tools;
	}

	public function getTool(string $name): ?AgentTool {
		return $this->getTools()[$name] ?? null;
	}

	/**
	 * @return list<AgentTool>
	 */
	public function resourceTools(string $registeringApp, IAgentResourceProvider $provider): array {
		$app = $provider->getAppId();
		$resource = $provider->getResourceName();
		$area = strtolower($provider->getScopeArea());
		$schema = $provider->getSchema();
		$this->check($registeringApp, $app, $resource, $area);
		if (($schema['type'] ?? null) !== 'object' || !isset($schema['properties']['id'])) {
			throw new \InvalidArgumentException("Schema of $app.$resource must be an object with an id property");
		}
		$filter = $provider->getListFilterSchema();
		if ($filter !== [] && ($filter['type'] ?? null) !== 'object') {
			throw new \InvalidArgumentException("List filter schema of $app.$resource must be an object schema");
		}
		$writable = self::writableSchema($schema);
		$id = ['type' => 'string', 'description' => "Id of the $resource"];
		$base = "$app.$resource";
		$what = rtrim($provider->getDescription());
		$R = IScopeRegistry::ACTION_READ;
		$W = IScopeRegistry::ACTION_WRITE;
		$D = IScopeRegistry::ACTION_DELETE;

		$listInput = [
			'type' => 'object',
			'properties' => [
				'filter' => $filter === [] ? ['type' => 'object', 'additionalProperties' => false] : $filter,
				'limit' => ['type' => 'integer', 'minimum' => 1, 'maximum' => 200, 'default' => 50],
				'cursor' => ['type' => ['string', 'null'], 'description' => 'nextCursor of the previous page'],
			],
			'additionalProperties' => false,
		];
		return [
			new AgentTool("$base.list", $app, AgentTool::OP_LIST, "List {$resource}s. $what", $listInput, $area, $R, false, $provider),
			new AgentTool("$base.get", $app, AgentTool::OP_GET, "Get one $resource by id. $what",
				self::object(['id' => $id], ['id']), $area, $R, false, $provider),
			new AgentTool("$base.create", $app, AgentTool::OP_CREATE, "Create a $resource. $what",
				self::object(['data' => $writable], ['data']), $area, $W, false, $provider),
			new AgentTool("$base.update", $app, AgentTool::OP_UPDATE, "Update a $resource; only the given properties change. $what",
				self::object(['id' => $id, 'data' => $writable], ['id', 'data']), $area, $W, false, $provider),
			new AgentTool("$base.delete", $app, AgentTool::OP_DELETE, "Delete a $resource. $what",
				self::object(['id' => $id], ['id']), $area, $D, false, $provider),
		];
	}

	/**
	 * @return list<AgentTool>
	 */
	public function actionTools(string $registeringApp, IAgentActionProvider $provider): array {
		$app = $provider->getAppId();
		$name = $provider->getName();
		$area = strtolower($provider->getScopeArea());
		$action = strtolower($provider->getScopeAction());
		$this->check($registeringApp, $app, $name, $area);
		if (preg_match(self::NAME, $action) !== 1) {
			throw new \InvalidArgumentException("Invalid scope action for $app.$name");
		}
		if (in_array($name, AgentTool::CRUD, true)) {
			throw new \InvalidArgumentException("Action $app.$name clashes with a CRUD operation name");
		}
		$input = $provider->getInputSchema();
		if (($input['type'] ?? null) !== 'object') {
			throw new \InvalidArgumentException("Input schema of $app.$name must be an object schema");
		}
		return [new AgentTool("$app.$name", $app, AgentTool::OP_ACTION, rtrim($provider->getDescription()),
			$input, $area, $action, $provider->needsApproval(), $provider)];
	}

	/**
	 * The resource schema minus `id` and readOnly properties: what create/update take.
	 *
	 * @param array<string, mixed> $schema
	 * @return array<string, mixed>
	 */
	public static function writableSchema(array $schema): array {
		$properties = [];
		foreach ($schema['properties'] ?? [] as $key => $property) {
			if ($key === 'id' || (is_array($property) && ($property['readOnly'] ?? false) === true)) {
				continue;
			}
			$properties[$key] = $property;
		}
		return [
			'type' => 'object',
			// An empty PHP array would encode as a JSON list.
			'properties' => $properties === [] ? new \stdClass() : $properties,
			'additionalProperties' => false,
		];
	}

	private function check(string $registeringApp, string $app, string $name, string $area): void {
		if ($app !== $registeringApp) {
			throw new \InvalidArgumentException("Provider claims app $app but was registered by $registeringApp");
		}
		if (preg_match(self::APP_ID, $app) !== 1) {
			throw new \InvalidArgumentException("Invalid app id $app");
		}
		if (preg_match(self::NAME, $name) !== 1) {
			throw new \InvalidArgumentException("Invalid name $app.$name");
		}
		if (preg_match(self::NAME, $area) !== 1 || in_array($area, self::FORBIDDEN_AREAS, true)) {
			throw new \InvalidArgumentException("Invalid scope area $area for $app.$name");
		}
	}

	/**
	 * @template T
	 * @param class-string<T> $interface
	 * @return T|null
	 */
	private function resolve(string $appId, string $class, string $interface): ?object {
		if (!$this->appManager->isEnabledForAnyone($appId)) {
			return null;
		}
		try {
			$provider = $this->container->get($class);
		} catch (\Throwable $e) {
			$this->logger->error('Could not load agent tool provider ' . $class, ['app' => $appId, 'exception' => $e]);
			return null;
		}
		if (!$provider instanceof $interface) {
			$this->logger->error("Agent tool provider $class does not implement $interface", ['app' => $appId]);
			return null;
		}
		return $provider;
	}

	/**
	 * @param array<string, AgentTool> $tools
	 * @param \Closure(): list<AgentTool> $build
	 */
	private function addAll(array &$tools, string $appId, \Closure $build): void {
		try {
			$new = $build();
		} catch (\Throwable $e) {
			$this->logger->error('Skipping invalid agent tool provider: ' . $e->getMessage(), ['app' => $appId, 'exception' => $e]);
			return;
		}
		foreach ($new as $tool) {
			if (isset($tools[$tool->name])) {
				$this->logger->error('Duplicate agent tool ' . $tool->name . ', keeping the first one', ['app' => $tool->appId]);
				continue;
			}
			$tools[$tool->name] = $tool;
		}
	}

	/**
	 * @param array<string, mixed> $properties
	 * @param list<string> $required
	 * @return array<string, mixed>
	 */
	private static function object(array $properties, array $required): array {
		return ['type' => 'object', 'properties' => $properties, 'required' => $required, 'additionalProperties' => false];
	}
}
