<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Atrium;

use OC\Agent\InternalAuth;
use OCA\Mail\Db\MailAccount;
use OCA\Mail\Db\MailAccountMapper;
use OCA\Mail\Db\MailboxMapper;
use OCA\Mail\IMAP\IMAPClientFactory;
use OCA\Mail\Service\AccountService;
use OCA\Mail\Service\MailManager;
use OCA\Mail\Service\Triage\TriageService;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\Http\Client\IClient;
use OCP\Http\Client\IClientService;
use OCP\Http\Client\IResponse;
use OCP\IAppConfig;
use OCP\ICacheFactory;
use OCP\IConfig;
use Psr\Log\LoggerInterface;

/**
 * P2-4: classification through the Bun provider layer (POST
 * /agent/v1/internal/ai/triage) instead of tollgate. The HTTP client is fake:
 * no network, no AI. The mail body is already stored, so no IMAP either.
 */
class TriageAiBackendTest extends MailDbTestCase {
	private const KEYS = ['triage_enabled', 'triage_backend', 'triage_tollgate_token', 'triage_cap_total_eur', TriageService::STATE_KEY];

	private MailAccount $row;
	private IAppConfig $config;
	/** @var array<string, string|bool|float|null> */
	private array $saved = [];
	/** @var list<array{url: string, options: array}> */
	private array $calls = [];
	/** @var list<array{0: int, 1: string}> */
	private array $replies = [];
	private string $hash;

	protected function setUp(): void {
		parent::setUp();
		$this->config = \OCP\Server::get(IAppConfig::class);
		foreach (self::KEYS as $k) {
			$this->saved[$k] = !$this->config->hasKey('mail', $k) ? null : match ($k) {
				'triage_enabled' => $this->config->getValueBool('mail', $k),
				'triage_cap_total_eur' => $this->config->getValueFloat('mail', $k),
				default => $this->config->getValueString('mail', $k),
			};
		}
		$ma = new MailAccount();
		$ma->setUserId('atrium-ai-' . bin2hex(random_bytes(3)));
		$ma->setName('Test');
		$ma->setEmail('test@atrium.invalid');
		$ma->setInboundHost('imap.atrium.invalid');
		$ma->setInboundPort(993);
		$ma->setInboundSslMode('ssl');
		$ma->setInboundUser('test@atrium.invalid');
		$ma->setInboundPassword('x');
		$ma->setOutboundHost('smtp.atrium.invalid');
		$ma->setOutboundPort(465);
		$ma->setOutboundSslMode('ssl');
		$ma->setOutboundUser('test@atrium.invalid');
		$ma->setOutboundPassword('x');
		$this->row = \OCP\Server::get(MailAccountMapper::class)->insert($ma);
		$this->account = new \OCA\Mail\Account($this->row);

		$this->hash = TriageService::hash('<ai@t>', 1);
		$id = $this->row->getId();
		$this->db->executeStatement(
			'INSERT INTO *PREFIX*mail_bodies (account_id, msg_hash, headers, body, attachments, has_unsubscribe, sent_at, fetched_at) VALUES (?, ?, ?, ?, ?, false, ?, ?)',
			[$id, $this->hash, "From: Tax office <tax@gov.invalid>\nSubject: Pay by Friday", 'Please pay your tax by Friday.', '', 1700000000, 1700000001],
		);
		// Priority 2 and far in the future: the first job any run picks.
		$this->db->executeStatement(
			'INSERT INTO *PREFIX*mail_triage_queue (account_id, msg_hash, db_id, priority, sent_at, status, attempts, enqueued_at, updated_at) VALUES (?, ?, ?, 2, ?, ?, 0, ?, ?)',
			[$id, $this->hash, 1, 2147000000, 'pending', 1700000000, 1700000000],
		);
		$this->config->setValueBool('mail', 'triage_enabled', true);
		$this->config->setValueFloat('mail', 'triage_cap_total_eur', 1000.0);
		$this->config->deleteKey('mail', 'triage_tollgate_token');
		$this->config->deleteKey('mail', 'triage_backend');
		$this->config->setValueString('mail', TriageService::STATE_KEY, '{}');
	}

	protected function tearDown(): void {
		$id = $this->row->getId();
		$this->db->executeStatement('DELETE FROM *PREFIX*mail_triage WHERE account_id = ?', [$id]);
		$this->db->executeStatement('DELETE FROM *PREFIX*mail_triage_queue WHERE account_id = ?', [$id]);
		foreach ($this->saved as $k => $v) {
			$this->config->deleteKey('mail', $k);
			if (is_bool($v)) {
				$this->config->setValueBool('mail', $k, $v);
			} elseif (is_float($v)) {
				$this->config->setValueFloat('mail', $k, $v);
			} elseif ($v !== null) {
				$this->config->setValueString('mail', $k, $v);
			}
		}
		parent::tearDown();
		$this->db->executeStatement('DELETE FROM *PREFIX*mail_accounts WHERE id = ?', [$id]);
	}

	private function service(): TriageService {
		$client = $this->createMock(IClient::class);
		$client->method('post')->willReturnCallback(function (string $url, array $options) {
			$this->calls[] = ['url' => $url, 'options' => $options];
			[$status, $body] = array_shift($this->replies) ?? [503, '{}'];
			$res = $this->createMock(IResponse::class);
			$res->method('getStatusCode')->willReturn($status);
			$res->method('getBody')->willReturn($body);
			return $res;
		});
		$clients = $this->createMock(IClientService::class);
		$clients->method('newClient')->willReturn($client);
		$s = \OCP\Server::class;
		return new TriageService(
			$this->db, $this->config, $s::get(IConfig::class), $s::get(ITimeFactory::class), $clients,
			$s::get(AccountService::class), $s::get(MailboxMapper::class), $s::get(MailManager::class),
			$s::get(IMAPClientFactory::class), $s::get(LoggerInterface::class), $s::get(ICacheFactory::class),
		);
	}

	private function decisions(): string {
		return json_encode([
			'answers' => [
				['name' => 'category', 'type' => 'choice', 'choice' => 'admin', 'confidence' => 0.9],
				['name' => 'needs_reply', 'type' => 'predicate', 'probability' => 0.1],
				['name' => 'needs_action', 'type' => 'predicate', 'probability' => 0.8],
				['name' => 'has_deadline', 'type' => 'predicate', 'probability' => 0.7],
				['name' => 'written_by_person', 'type' => 'predicate', 'probability' => 0.2],
				['name' => 'suspicious', 'type' => 'predicate', 'probability' => 0.05],
				['name' => 'urgency', 'type' => 'score', 'score' => 0.5, 'probabilities' => [['label' => 'never', 'probability' => 0], ['label' => 'this_week', 'probability' => 1]]],
			],
			'model' => 'mock-small', 'provider' => 'inst', 'providerLabel' => 'Instance AI',
			'usage' => ['input_tokens' => 1000, 'output_tokens' => 100, 'estimated' => false],
		]);
	}

	/** One job through classifyOne (a full run would also pick other pending mail of the test DB). */
	private function classifyOne(TriageService $t): string {
		$job = $this->db->executeQuery('SELECT * FROM *PREFIX*mail_triage_queue WHERE account_id = ?', [$this->row->getId()])->fetch();
		$m = new \ReflectionMethod($t, 'classifyOne');
		$qs = (new \ReflectionMethod($t, 'questions'))->invoke($t);
		return $m->invoke($t, $job, $t->settings(), $qs, '');
	}

	private function queueRow(): array {
		return $this->db->executeQuery('SELECT status, attempts, last_error FROM *PREFIX*mail_triage_queue WHERE account_id = ?', [$this->row->getId()])->fetch();
	}

	public function testBackendDefaultsToAiAndExistingTollgateInstallsKeepTollgate(): void {
		$t = $this->service();
		$this->assertSame('ai', $t->settings()['backend']);
		$this->assertTrue($t->settings()['configured'], 'ai is configured from Settings > AI, checked by the Bun server');
		$this->config->setValueString('mail', 'triage_tollgate_token', 'fake-token');
		$this->assertSame('tollgate', $t->settings()['backend']);
		$this->config->setValueString('mail', 'triage_backend', 'ai');
		$this->assertSame('ai', $t->settings()['backend'], 'an explicit choice wins');
	}

	public function testAiClassifiesAsTheAccountOwnerAndStoresMailV2(): void {
		$this->replies[] = [200, $this->decisions()];
		$t = $this->service();
		$this->assertSame('ok', $this->classifyOne($t));

		$this->assertCount(1, $this->calls);
		$this->assertStringEndsWith('/agent/v1/internal/ai/triage', $this->calls[0]['url']);
		$o = $this->calls[0]['options'];
		$this->assertSame(\OCP\Server::get(InternalAuth::class)->expected(), $o['headers'][InternalAuth::HEADER]);
		$this->assertNotSame('', $o['headers'][InternalAuth::HEADER]);
		$this->assertSame($this->row->getUserId(), $o['json']['uid']);
		$this->assertSame('mail-v2', $o['json']['version']);
		$this->assertStringContainsString('Pay by Friday', $o['json']['input']);
		$this->assertCount(7, $o['json']['questions']);

		$r = $this->db->executeQuery('SELECT * FROM *PREFIX*mail_triage WHERE account_id = ?', [$this->row->getId()])->fetch();
		$this->assertSame('admin', $r['category']);
		$this->assertSame('this_week', $r['urgency']);
		$this->assertEqualsWithDelta(0.8, (float)$r['needs_action'], 0.001);
		$this->assertSame('mock-small', $r['model']);
		$this->assertSame(1100, (int)$r['input_tokens'], 'input + output tokens');
		$this->assertGreaterThan(0, (float)$r['cost_eur']);
		$this->assertSame('done', $this->queueRow()['status']);
		$this->assertSame('Instance AI · mock-small', $t->state()['lastModel']);
		$this->assertSame('Instance AI · mock-small', $t->status($this->row->getUserId())['settings']['model']);
	}

	public function testBadModelAnswerCountsAnAttemptWithoutPausing(): void {
		$this->replies[] = [422, json_encode(['code' => 'invalid', 'message' => 'triage: answer "category" is not one of the choices'])];
		$t = $this->service();
		$this->assertSame('skipped', $this->classifyOne($t));
		$q = $this->queueRow();
		$this->assertSame('pending', $q['status']);
		$this->assertSame(1, (int)$q['attempts']);
		$this->assertStringContainsString('not one of the choices', $q['last_error']);
	}

	public function testRunStatesFromTheAiAnswers(): void {
		$now = time();
		$cases = [
			[402, ['code' => 'budget', 'reason' => 'daily_cap', 'message' => 'cap', 'until' => $now + 5000], 'budget_exhausted', $now + 5000],
			[401, ['code' => 'unauthorized', 'message' => 'bad key', 'until' => $now + 7200], 'unauthorized', $now + 7200],
			[409, ['code' => 'not_configured', 'message' => 'No AI for mail triage'], 'not_configured', null],
			[429, ['code' => 'rate_limit', 'message' => 'slow down', 'until' => $now + 4000], 'backoff', $now + 4000],
		];
		foreach ($cases as [$status, $body, $state, $until]) {
			$this->config->setValueString('mail', TriageService::STATE_KEY, '{}');
			$this->calls = [];
			$this->replies = [[$status, json_encode($body)]];
			$t = $this->service();
			$this->assertSame(0, $t->classify(time() + 30));
			$this->assertCount(1, $this->calls, "$status: one call, then the run stops");
			$s = $t->state();
			$this->assertSame($state, $s['state'], "state after $status");
			if ($until !== null) {
				$this->assertSame($until, $s['pausedUntil'], "the AI's until is kept after $status");
			} else {
				$this->assertGreaterThan(time(), $s['pausedUntil']);
			}
			$this->assertStringContainsString($body['message'], (string)$s['lastError']);
			$this->assertSame('pending', $this->queueRow()['status'], 'the mail stays queued');
		}
		$this->assertSame(0, (int)$this->queueRow()['attempts'], 'pipeline problems never count against the mail');
	}

	public function testAnAiAddedAfterNoAiIsUsedOnTheNextRunNotTenMinutesLater(): void {
		// The previous run found no AI and paused for 10 minutes...
		$this->config->setValueString('mail', TriageService::STATE_KEY, json_encode(['state' => 'not_configured', 'pausedUntil' => time() + 600]));
		// ...then the owner added one in Settings > AI.
		$this->replies = [[200, $this->decisions()]];
		$t = $this->service();
		$t->classify(time() + 5);
		$this->assertNotEmpty($this->calls, 'the run asks the AI again at once');
		$this->assertSame('done', $this->queueRow()['status']);

		// Other pauses (budget, rate limit...) still hold.
		$this->config->setValueString('mail', TriageService::STATE_KEY, json_encode(['state' => 'budget_exhausted', 'pausedUntil' => time() + 600]));
		$this->calls = [];
		$this->assertSame(0, $this->service()->classify(time() + 5));
		$this->assertCount(0, $this->calls);
	}

	public function testUnreachableServerIsTransient(): void {
		$client = $this->createMock(IClient::class);
		$client->method('post')->willThrowException(new \RuntimeException('Connection refused'));
		$clients = $this->createMock(IClientService::class);
		$clients->method('newClient')->willReturn($client);
		$s = \OCP\Server::class;
		$t = new TriageService(
			$this->db, $this->config, $s::get(IConfig::class), $s::get(ITimeFactory::class), $clients,
			$s::get(AccountService::class), $s::get(MailboxMapper::class), $s::get(MailManager::class),
			$s::get(IMAPClientFactory::class), $s::get(LoggerInterface::class), $s::get(ICacheFactory::class),
		);
		$this->assertSame('transient', $this->classifyOne($t));
		$this->assertStringContainsString('AI unreachable: Connection refused', (string)$t->state()['lastError']);
	}
}
