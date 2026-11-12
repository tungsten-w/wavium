<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace Test\Agent\Tool;

use OC\Agent\Tool\AgentTool;
use OC\Agent\Tool\ToolRegistry;
use OC\AppFramework\Bootstrap\Coordinator;
use OC\AppFramework\Bootstrap\RegistrationContext;
use OCP\Agent\IAgentContext;
use OCP\Agent\Tool\IAgentActionProvider;
use OCP\Agent\Tool\IAgentResourceProvider;
use OCP\Agent\Tool\ResourcePage;
use OCP\App\IAppManager;
use PHPUnit\Framework\MockObject\MockObject;
use Psr\Container\ContainerInterface;
use Psr\Log\LoggerInterface;
use Test\TestCase;

class ToolRegistryTest extends TestCase {
	private Coordinator&MockObject $coordinator;
	private ContainerInterface&MockObject $container;
	private IAppManager&MockObject $appManager;
	private LoggerInterface&MockObject $logger;
	private RegistrationContext $context;
	/** @var array<string, object> */
	private array $providers = [];

	#[\Override]
	protected function setUp(): void {
		parent::setUp();
		$this->coordinator = $this->createMock(Coordinator::class);
		$this->container = $this->createMock(ContainerInterface::class);
		$this->appManager = $this->createMock(IAppManager::class);
		$this->logger = $this->createMock(LoggerInterface::class);
		$this->context = new RegistrationContext($this->createMock(LoggerInterface::class));
		$this->coordinator->method('getRegistrationContext')->willReturn($this->context);
		$this->container->method('get')->willReturnCallback(fn (string $id) => $this->providers[$id] ?? throw new \RuntimeException("no $id"));
		$this->appManager->method('isEnabledForAnyone')->willReturnCallback(fn (string $app) => $app !== 'disabled_app');
	}

	private function registry(): ToolRegistry {
		return new ToolRegistry($this->coordinator, $this->container, $this->appManager, $this->logger);
	}

	private function resource(string $app, string $name = 'contact', string $area = 'contacts', ?array $schema = null): IAgentResourceProvider {
		return new class($app, $name, $area, $schema) implements IAgentResourceProvider {
			public function __construct(
				private string $app,
				private string $name,
				private string $area,
				private ?array $schema,
			) {
			}
			public function getAppId(): string {
				return $this->app;
			}
			public function getResourceName(): string {
				return $this->name;
			}
			public function getScopeArea(): string {
				return $this->area;
			}
			public function getDescription(): string {
				return 'A person in the address book.';
			}
			public function getSchema(): array {
				return $this->schema ?? ['type' => 'object', 'properties' => [
					'id' => ['type' => 'string', 'readOnly' => true],
					'name' => ['type' => 'string'],
					'etag' => ['type' => 'string', 'readOnly' => true],
				]];
			}
			public function getListFilterSchema(): array {
				return ['type' => 'object', 'properties' => ['search' => ['type' => 'string']]];
			}
			public function list(IAgentContext $context, array $filter, int $limit, ?string $cursor): ResourcePage {
				return new ResourcePage([]);
			}
			public function get(IAgentContext $context, string $id): array {
				return ['id' => $id];
			}
			public function create(IAgentContext $context, array $data): array {
				return ['id' => '1'] + $data;
			}
			public function update(IAgentContext $context, string $id, array $data): array {
				return ['id' => $id] + $data;
			}
			public function delete(IAgentContext $context, string $id): void {
			}
		};
	}

	private function action(string $app, string $name = 'send_message', string $scopeAction = 'send'): IAgentActionProvider {
		return new class($app, $name, $scopeAction) implements IAgentActionProvider {
			public function __construct(
				private string $app,
				private string $name,
				private string $scopeAction,
			) {
			}
			public function getAppId(): string {
				return $this->app;
			}
			public function getName(): string {
				return $this->name;
			}
			public function getScopeArea(): string {
				return 'mail';
			}
			public function getScopeAction(): string {
				return $this->scopeAction;
			}
			public function getDescription(): string {
				return 'Send a mail.';
			}
			public function getInputSchema(): array {
				return ['type' => 'object', 'properties' => ['to' => ['type' => 'string']]];
			}
			public function needsApproval(): bool {
				return true;
			}
			public function execute(IAgentContext $context, array $input): array {
				return [];
			}
		};
	}

	private function registerResource(string $registeringApp, string $class, object $provider): void {
		$this->providers[$class] = $provider;
		$this->context->registerAgentResourceProvider($registeringApp, $class);
	}

	private function registerAction(string $registeringApp, string $class, object $provider): void {
		$this->providers[$class] = $provider;
		$this->context->registerAgentActionProvider($registeringApp, $class);
	}

	public function testResourceGivesFullCrud(): void {
		$this->registerResource('contacts', 'ContactProvider', $this->resource('contacts'));
		$tools = $this->registry()->getTools();

		$this->assertSame([
			'contacts.contact.create',
			'contacts.contact.delete',
			'contacts.contact.get',
			'contacts.contact.list',
			'contacts.contact.update',
		], array_keys($tools));
		$scopes = array_map(fn (AgentTool $t) => $t->getScope(), $tools);
		$this->assertSame('contacts:read', $scopes['contacts.contact.list']);
		$this->assertSame('contacts:read', $scopes['contacts.contact.get']);
		$this->assertSame('contacts:write', $scopes['contacts.contact.create']);
		$this->assertSame('contacts:write', $scopes['contacts.contact.update']);
		$this->assertSame('contacts:delete', $scopes['contacts.contact.delete']);

		// create/update take only writable properties.
		$data = $tools['contacts.contact.create']->inputSchema['properties']['data'];
		$this->assertSame(['name'], array_keys($data['properties']));
		$this->assertSame(['id', 'data'], $tools['contacts.contact.update']->inputSchema['required']);
		$this->assertSame(['search' => ['type' => 'string']], $tools['contacts.contact.list']->inputSchema['properties']['filter']['properties']);

		$mcp = $tools['contacts.contact.get']->toMcp();
		$this->assertSame('contacts.contact.get', $mcp['name']);
		$this->assertStringContainsString('address book', $mcp['description']);
		$this->assertSame(['id'], $mcp['inputSchema']['required']);
		$this->assertJson(json_encode($mcp, JSON_THROW_ON_ERROR));
	}

	public function testAction(): void {
		$this->registerAction('mail', 'SendAction', $this->action('mail'));
		$tool = $this->registry()->getTool('mail.send_message');
		$this->assertNotNull($tool);
		$this->assertSame('mail:send', $tool->getScope());
		$this->assertSame(AgentTool::OP_ACTION, $tool->operation);
		$this->assertTrue($tool->needsApproval);
	}

	public function testDisabledAppHasNoTools(): void {
		$this->registerResource('disabled_app', 'P', $this->resource('disabled_app'));
		$this->assertSame([], $this->registry()->getTools());
	}

	public static function invalidResources(): array {
		return [
			'claims another app' => ['contacts', 'calendar', 'contact', 'contacts', null],
			'bad resource name' => ['contacts', 'contacts', 'Contact!', 'contacts', null],
			'admin area' => ['contacts', 'contacts', 'contact', 'admin', null],
			'security area' => ['contacts', 'contacts', 'contact', 'security', null],
			'schema without id' => ['contacts', 'contacts', 'contact', 'contacts', ['type' => 'object', 'properties' => ['name' => []]]],
			'schema not an object' => ['contacts', 'contacts', 'contact', 'contacts', ['type' => 'array']],
		];
	}

	#[\PHPUnit\Framework\Attributes\DataProvider('invalidResources')]
	public function testInvalidResourceIsSkippedAndLogged(string $registering, string $claimed, string $name, string $area, ?array $schema): void {
		$this->registerResource($registering, 'Bad', $this->resource($claimed, $name, $area, $schema));
		$this->registerResource('notes', 'Good', $this->resource('notes', 'note', 'notes'));
		$this->logger->expects($this->once())->method('error');
		$tools = $this->registry()->getTools();
		$this->assertCount(5, $tools);
		$this->assertArrayHasKey('notes.note.list', $tools);
	}

	public function testActionNamedLikeCrudRejected(): void {
		$this->registerAction('mail', 'A', $this->action('mail', 'delete'));
		$this->logger->expects($this->once())->method('error');
		$this->assertSame([], $this->registry()->getTools());
	}

	public function testDuplicateKeepsFirst(): void {
		$first = $this->resource('contacts');
		$this->registerResource('contacts', 'First', $first);
		$this->registerResource('contacts', 'Second', $this->resource('contacts'));
		$this->logger->expects($this->exactly(5))->method('error');
		$tools = $this->registry()->getTools();
		$this->assertCount(5, $tools);
		$this->assertSame($first, $tools['contacts.contact.get']->provider);
	}

	public function testBrokenServiceIsSkipped(): void {
		$this->context->registerAgentResourceProvider('contacts', 'Missing');
		$this->providers['WrongType'] = new \stdClass();
		$this->context->registerAgentResourceProvider('contacts', 'WrongType');
		$this->logger->expects($this->exactly(2))->method('error');
		$this->assertSame([], $this->registry()->getTools());
	}

	public function testWritableSchemaOfReadOnlyResourceEncodesAsObject(): void {
		$schema = ToolRegistry::writableSchema(['type' => 'object', 'properties' => ['id' => ['type' => 'string']]]);
		$this->assertSame('{"type":"object","properties":{},"additionalProperties":false}', json_encode($schema));
	}
}
