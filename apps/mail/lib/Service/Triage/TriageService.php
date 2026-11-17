<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Service\Triage;

use Horde_Imap_Client;
use Horde_Text_Filter;
use OCA\Mail\Account;
use OCA\Mail\AppInfo\Application;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Db\MailboxMapper;
use OCA\Mail\IMAP\IMAPClientFactory;
use OCA\Mail\Service\AccountService;
use OCA\Mail\Service\MailManager;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\Http\Client\IClientService;
use OCP\IAppConfig;
use OCP\ICacheFactory;
use OCP\IConfig;
use OCP\IDBConnection;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * Atrium triage: classifies mail with the AI chosen in Settings > AI (P2-4:
 * the Bun provider layer, POST /agent/v1/internal/ai/triage, small model,
 * usage counted in the AI budget), or, where it was set up before, through
 * tollgate's decisions API. Both answer in the same decisions shape (mail-v2).
 * Backend: app config `triage_backend` = ai | tollgate; unset = tollgate when a
 * tollgate token exists (existing installs keep working), else ai.
 *
 * Pipeline: enqueue() finds inbox/spam mail not seen yet -> mail_triage_queue
 * (pending) -> classify() fetches the text over IMAP (peek), asks the
 * decisions API, stores mail_triage and marks the queue row done. New mail
 * goes first; the backlog runs newest first under its own daily € cap.
 * State for the status page lives in app config "triage_state".
 */
class TriageService {
	public const STATE_KEY = 'triage_state';

	/** @var array<int, \Horde_Imap_Client_Socket> One IMAP login per account per run: Gmail locks out frequent logins. */
	private array $imap = [];

	/** When the AI said to come back (unix time), for the last 'budget' / 'transient' / 'unauthorized' result. */
	private ?int $retryAt = null;

	public function __construct(
		private IDBConnection $db,
		private IAppConfig $appConfig,
		private IConfig $config,
		private ITimeFactory $time,
		private IClientService $clients,
		private AccountService $accounts,
		private MailboxMapper $mailboxes,
		private MailManager $mailManager,
		private IMAPClientFactory $imapFactory,
		private LoggerInterface $logger,
		private ICacheFactory $caches,
	) {
	}

	private const RUN_LOCK_TTL = 300;

	/**
	 * Queue new mail and classify until $deadline, one run at a time (the 5-min
	 * job and classify-on-arrival share it). Null when another run holds the lock;
	 * that run picks up newly queued mail itself, since nextJob() reads the queue
	 * every time.
	 * @return array{queued: int, classified: int}|null
	 */
	public function run(int $deadline): ?array {
		$lock = $this->caches->createLocking('mail-triage');
		$token = bin2hex(random_bytes(8));
		if (!$lock->add('run', $token, self::RUN_LOCK_TTL)) {
			return null;
		}
		try {
			$queued = $this->enqueue();
			return ['queued' => $queued, 'classified' => $this->classify($deadline)];
		} finally {
			$lock->cad('run', $token);
		}
	}

	/** @return array{enabled: bool, backend: string, configured: bool, url: string, serverUrl: string, capTotal: float, capBackfill: float, pricePerMUsd: float, usdToEur: float, bodyChars: int, newDays: int, timezone: string} */
	public function settings(): array {
		$a = Application::APP_ID;
		$hasToken = $this->appConfig->getValueString($a, 'triage_tollgate_token', '') !== '';
		$backend = $this->appConfig->getValueString($a, 'triage_backend', '');
		if ($backend !== 'ai' && $backend !== 'tollgate') {
			$backend = $hasToken ? 'tollgate' : 'ai';
		}
		return [
			'enabled' => $this->appConfig->getValueBool($a, 'triage_enabled', false),
			'backend' => $backend,
			// ai: whether a provider exists is known only to the Bun server; it answers 409 when none.
			'configured' => $backend === 'ai' || $hasToken,
			'url' => rtrim($this->appConfig->getValueString($a, 'triage_tollgate_url', 'http://tollgate:8787'), '/'),
			// The Bun server on the private network (dev compose: service "web").
			'serverUrl' => rtrim((string)(getenv('ATRIUM_SERVER_URL') ?: $this->config->getSystemValueString('atrium.server_url', 'http://web:8080')), '/'),
			'capTotal' => $this->appConfig->getValueFloat($a, 'triage_cap_total_eur', 1.0),
			'capBackfill' => $this->appConfig->getValueFloat($a, 'triage_cap_backfill_eur', 0.30),
			'pricePerMUsd' => $this->appConfig->getValueFloat($a, 'triage_price_per_m_usd', 0.10),
			'usdToEur' => $this->appConfig->getValueFloat($a, 'triage_usd_to_eur', 0.92),
			'bodyChars' => $this->appConfig->getValueInt($a, 'triage_body_chars', 6000),
			'newDays' => $this->appConfig->getValueInt($a, 'triage_new_days', 7),
			'timezone' => $this->config->getSystemValueString('default_timezone', 'Europe/Paris') ?: 'Europe/Paris',
		];
	}

	public function setEnabled(bool $enabled): void {
		$this->appConfig->setValueBool(Application::APP_ID, 'triage_enabled', $enabled);
		$this->saveState(['state' => $enabled ? 'idle' : 'disabled']);
	}

	/** @return array<string, mixed> */
	public function state(): array {
		$raw = $this->appConfig->getValueString(Application::APP_ID, self::STATE_KEY, '{}');
		$s = json_decode($raw, true);
		return is_array($s) ? $s : [];
	}

	/** @param array<string, mixed> $patch */
	private function saveState(array $patch): void {
		$this->appConfig->setValueString(Application::APP_ID, self::STATE_KEY, json_encode(array_merge($this->state(), $patch)) ?: '{}');
	}

	/** Same mail = same account + same Message-ID, whatever folder or db id it has. */
	public static function hash(?string $messageId, int $dbId): string {
		return md5($messageId !== null && $messageId !== '' ? $messageId : "db:$dbId");
	}

	/** @return array{version: string, model: string, questions: list<mixed>} */
	private function questions(): array {
		$d = json_decode((string)file_get_contents(__DIR__ . '/questions.json'), true);
		return ['version' => (string)$d['version'], 'model' => (string)($d['model'] ?? 'gpt-6-luna'), 'questions' => $d['questions']];
	}

	/** @return list<Mailbox> Inbox and spam folders: the mail worth classifying. */
	private function triageMailboxes(): array {
		$qb = $this->db->getQueryBuilder();
		$rows = $qb->select('id')->from('mail_mailboxes')->executeQuery()->fetchAll();
		$boxes = $this->mailboxes->findByIds(array_map(static fn ($r) => (int)$r['id'], $rows));
		return array_values(array_filter($boxes, static fn (Mailbox $b) => $b->isInbox() || $b->isSpecialUse(Horde_Imap_Client::SPECIALUSE_JUNK)));
	}

	/**
	 * Queue every inbox/spam mail not queued yet. Scans only mail_messages rows
	 * newer than the last scan, so a run after the first is cheap.
	 */
	public function enqueue(): int {
		$boxes = $this->triageMailboxes();
		if ($boxes === []) {
			return 0;
		}
		$accountOf = [];
		foreach ($boxes as $b) {
			$accountOf[$b->getId()] = $b->getAccountId();
		}
		$state = $this->state();
		$upTo = (int)($state['scannedUpTo'] ?? 0);
		$firstDone = (bool)($state['firstScanDone'] ?? false);
		$now = $this->time->getTime();
		$recent = $now - $this->settings()['newDays'] * 86400;

		$known = [];
		foreach ($this->db->getQueryBuilder()->select('account_id', 'msg_hash')->from('mail_triage_queue')->executeQuery()->fetchAll() as $r) {
			$known[$r['account_id'] . ':' . $r['msg_hash']] = true;
		}

		$added = 0;
		while (true) {
			$qb = $this->db->getQueryBuilder();
			$rows = $qb->select('id', 'mailbox_id', 'message_id', 'sent_at')
				->from('mail_messages')
				->where($qb->expr()->gt('id', $qb->createNamedParameter($upTo, IQueryBuilder::PARAM_INT)))
				->andWhere($qb->expr()->in('mailbox_id', $qb->createNamedParameter(array_keys($accountOf), IQueryBuilder::PARAM_INT_ARRAY)))
				->orderBy('id', 'ASC')
				->setMaxResults(1000)
				->executeQuery()->fetchAll();
			if ($rows === []) {
				break;
			}
			$this->db->beginTransaction();
			try {
				foreach ($rows as $r) {
					$upTo = max($upTo, (int)$r['id']);
					$accountId = $accountOf[(int)$r['mailbox_id']];
					$hash = self::hash($r['message_id'], (int)$r['id']);
					$key = "$accountId:$hash";
					if (isset($known[$key])) {
						// Seen before (other folder, or resynced): remember the newest db id.
						$u = $this->db->getQueryBuilder();
						$u->update('mail_triage_queue')->set('db_id', $u->createNamedParameter((int)$r['id'], IQueryBuilder::PARAM_INT))
							->where($u->expr()->eq('account_id', $u->createNamedParameter($accountId, IQueryBuilder::PARAM_INT)))
							->andWhere($u->expr()->eq('msg_hash', $u->createNamedParameter($hash)))
							->executeStatement();
						continue;
					}
					$known[$key] = true;
					$sentAt = (int)$r['sent_at'];
					$i = $this->db->getQueryBuilder();
					$i->insert('mail_triage_queue')->values([
						'account_id' => $i->createNamedParameter($accountId, IQueryBuilder::PARAM_INT),
						'msg_hash' => $i->createNamedParameter($hash),
						'db_id' => $i->createNamedParameter((int)$r['id'], IQueryBuilder::PARAM_INT),
						'priority' => $i->createNamedParameter(($firstDone || $sentAt >= $recent) ? 1 : 0, IQueryBuilder::PARAM_INT),
						'sent_at' => $i->createNamedParameter($sentAt, IQueryBuilder::PARAM_INT),
						'status' => $i->createNamedParameter('pending'),
						'enqueued_at' => $i->createNamedParameter($now, IQueryBuilder::PARAM_INT),
						'updated_at' => $i->createNamedParameter($now, IQueryBuilder::PARAM_INT),
					])->executeStatement();
					$added++;
				}
				$this->db->commit();
			} catch (Throwable $e) {
				$this->db->rollBack();
				throw $e;
			}
		}
		$this->saveState(['scannedUpTo' => $upTo, 'firstScanDone' => true, 'lastScan' => $now]);
		return $added;
	}

	/** Log out of every IMAP connection this run opened. */
	public function closeConnections(): void {
		foreach ($this->imap as $client) {
			try {
				$client->logout();
			} catch (Throwable) {
			}
		}
		$this->imap = [];
	}

	/** Unix time of local midnight today in the server's timezone. */
	private function midnight(): int {
		$tz = new \DateTimeZone($this->settings()['timezone']);
		return (new \DateTimeImmutable('today', $tz))->getTimestamp();
	}

	/** @return array{total: float, backfill: float} € spent since local midnight */
	public function spentToday(): array {
		$qb = $this->db->getQueryBuilder();
		$rows = $qb->select('cost_eur', 'backfill')->from('mail_triage')
			->where($qb->expr()->gte('classified_at', $qb->createNamedParameter($this->midnight(), IQueryBuilder::PARAM_INT)))
			->executeQuery()->fetchAll();
		$total = 0.0;
		$backfill = 0.0;
		foreach ($rows as $r) {
			$total += (float)$r['cost_eur'];
			if ($r['backfill']) {
				$backfill += (float)$r['cost_eur'];
			}
		}
		return ['total' => $total, 'backfill' => $backfill];
	}

	/** @return array<string, mixed>|null Next queue row within today's caps, or null (state saved). */
	/** @param int[] $skip queue ids already tried in this run */
	private function nextJob(array $s, array $skip = []): ?array {
		$spent = $this->spentToday();
		if ($spent['total'] >= $s['capTotal']) {
			$this->saveState(['state' => 'daily_cap']);
			return null;
		}
		$minPrio = $spent['backfill'] >= $s['capBackfill'] ? 1 : 0;
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from('mail_triage_queue')
			->where($qb->expr()->eq('status', $qb->createNamedParameter('pending')))
			->andWhere($qb->expr()->gte('priority', $qb->createNamedParameter($minPrio, IQueryBuilder::PARAM_INT)));
		if ($skip !== []) {
			$qb->andWhere($qb->expr()->notIn('id', $qb->createNamedParameter($skip, IQueryBuilder::PARAM_INT_ARRAY)));
		}
		$qb->orderBy('priority', 'DESC')->addOrderBy('sent_at', 'DESC')
			->setMaxResults(1);
		$row = $qb->executeQuery()->fetch();
		if ($row === false) {
			$this->saveState(['state' => $minPrio === 1 && $this->pendingCount() > count($skip) ? 'backfill_cap' : 'idle']);
			return null;
		}
		return $row;
	}

	private function pendingCount(): int {
		$qb = $this->db->getQueryBuilder();
		return (int)$qb->select($qb->func()->count('*'))->from('mail_triage_queue')
			->where($qb->expr()->eq('status', $qb->createNamedParameter('pending')))->executeQuery()->fetchOne();
	}

	private function markQueue(int $id, string $status, ?string $error, bool $countAttempt = false): void {
		$qb = $this->db->getQueryBuilder();
		$qb->update('mail_triage_queue')
			->set('status', $qb->createNamedParameter($status))
			->set('last_error', $qb->createNamedParameter($error === null ? null : mb_substr($error, 0, 500)))
			->set('updated_at', $qb->createNamedParameter($this->time->getTime(), IQueryBuilder::PARAM_INT))
			->where($qb->expr()->eq('id', $qb->createNamedParameter($id, IQueryBuilder::PARAM_INT)));
		if ($countAttempt) {
			$qb->set('attempts', $qb->createFunction('attempts + 1'));
		}
		$qb->executeStatement();
	}

	/**
	 * Classify until $deadline (unix time), a cap, or a pause.
	 * @return int number classified
	 */
	public function classify(int $deadline): int {
		try {
			return $this->runClassify($deadline);
		} finally {
			$this->closeConnections();
		}
	}

	private function runClassify(int $deadline): int {
		$s = $this->settings();
		if (!$s['enabled']) {
			$this->saveState(['state' => 'disabled']);
			return 0;
		}
		if (!$s['configured']) {
			$this->saveState(['state' => 'not_configured']);
			return 0;
		}
		$state = $this->state();
		$now = $this->time->getTime();
		if ((int)($state['pausedUntil'] ?? 0) > $now) {
			return 0;
		}
		$token = $this->appConfig->getValueString(Application::APP_ID, 'triage_tollgate_token', '');
		$qs = $this->questions();
		$done = 0;
		// A mail that fails is retried on a later run (parked after 5 runs), not
		// hammered now; several failures in a row mean IMAP itself is in trouble.
		$skip = [];
		$failuresInRow = 0;
		$this->saveState(['state' => 'running', 'lastRun' => $now]);
		while ($this->time->getTime() < $deadline) {
			$job = $this->nextJob($s, $skip);
			if ($job === null) {
				return $done;
			}
			$skip[] = (int)$job['id'];
			$result = $this->classifyOne($job, $s, $qs, $token);
			if ($result === 'skipped') {
				if (++$failuresInRow >= 5) {
					$this->saveState(['state' => 'backoff', 'pausedUntil' => $this->time->getTime() + 600]);
					return $done;
				}
				continue;
			}
			$failuresInRow = 0;
			if ($result === 'ok') {
				$done++;
				$this->saveState(['lastOk' => $this->time->getTime(), 'lastError' => null, 'transientFailures' => 0]);
			} elseif ($result === 'budget') {
				// Budget used up (tollgate: monthly budget; AI: a cap or no credit). Wait
				// until the AI says, else local midnight.
				$this->saveState(['state' => 'budget_exhausted', 'pausedUntil' => $this->retryAt ?? $this->midnight() + 86400]);
				return $done;
			} elseif ($result === 'unauthorized') {
				$this->saveState(['state' => 'unauthorized', 'pausedUntil' => max($this->retryAt ?? 0, $this->time->getTime() + 3600)]);
				return $done;
			} elseif ($result === 'not_configured') {
				// No AI provider for this mail's owner: look again in 10 minutes.
				$this->saveState(['state' => 'not_configured', 'pausedUntil' => $this->time->getTime() + 600]);
				return $done;
			} elseif ($result === 'transient') {
				$n = (int)($this->state()['transientFailures'] ?? 0) + 1;
				$backoff = $this->time->getTime() + min(1800, 30 * 2 ** min($n, 6));
				$this->saveState(['state' => 'backoff', 'transientFailures' => $n, 'pausedUntil' => max($backoff, $this->retryAt ?? 0)]);
				return $done;
			}
		}
		$this->saveState(['state' => 'idle']);
		return $done;
	}

	/**
	 * @param array<string, mixed> $job
	 * @return string ok | skipped | budget | unauthorized | not_configured | transient
	 */
	private function classifyOne(array $job, array $s, array $qs, string $token): string {
		$queueId = (int)$job['id'];
		$this->retryAt = null;
		try {
			$input = $this->buildInput($job, $s);
		} catch (DoesNotExistException $e) {
			$this->markQueue($queueId, 'parked', 'Message no longer in Atrium: ' . $e->getMessage());
			return 'skipped';
		} catch (Throwable $e) {
			for ($x = $e; $x !== null; $x = $x->getPrevious()) {
				if (stripos($x->getMessage(), 'auth') !== false || stripos($x->getMessage(), 'login') !== false) {
					// Mail server refuses logins (e.g. Gmail "Too many auth attempts"): not this mail's fault.
					$this->markQueue($queueId, 'pending', 'Mail server refused the login: ' . $x->getMessage());
					$this->saveState(['lastError' => 'IMAP login refused: ' . $x->getMessage(), 'lastErrorAt' => $this->time->getTime()]);
					return 'transient';
				}
			}
			// IMAP trouble: count it, park after 5 tries so one bad mail never blocks the queue.
			$this->markQueue($queueId, (int)$job['attempts'] >= 4 ? 'parked' : 'pending', 'Fetching the mail failed: ' . $e->getMessage(), true);
			$this->saveState(['lastError' => 'IMAP: ' . $e->getMessage(), 'lastErrorAt' => $this->time->getTime()]);
			return 'skipped';
		}

		$ai = $s['backend'] === 'ai';
		$who = $ai ? 'AI' : 'Decisions API';
		try {
			$response = $ai ? $this->askAi($job, $s, $input, $qs) : $this->clients->newClient()->post($s['url'] . '/v1/decisions', [
				'json' => ['model' => $qs['model'], 'input' => $input, 'questions' => $qs['questions']],
				'headers' => ['Authorization' => 'Bearer ' . $token],
				'timeout' => 90,
				'http_errors' => false,
				// tollgate is a container on the private network.
				'nextcloud' => ['allow_local_address' => true],
			]);
		} catch (DoesNotExistException $e) {
			$this->markQueue($queueId, 'parked', $e->getMessage());
			return 'skipped';
		} catch (Throwable $e) {
			$this->markQueue($queueId, 'pending', "$who unreachable: " . $e->getMessage());
			$this->saveState(['lastError' => "$who unreachable: " . $e->getMessage(), 'lastErrorAt' => $this->time->getTime()]);
			return 'transient';
		}
		$status = $response->getStatusCode();
		$body = (string)$response->getBody();
		if ($ai && $status !== 200) {
			$err = json_decode($body, true);
			$until = is_array($err) && is_numeric($err['until'] ?? null) ? (int)$err['until'] : null;
			$this->retryAt = $until !== null && $until > $this->time->getTime() ? $until : null;
			$message = is_array($err) && is_string($err['message'] ?? null) ? $err['message'] : mb_substr($body, 0, 200);
			if ($status === 409) {
				$this->markQueue($queueId, 'pending', $message);
				$this->saveState(['lastError' => $message, 'lastErrorAt' => $this->time->getTime()]);
				return 'not_configured';
			}
			if ($status === 422) {
				// The model kept answering badly for this mail: count a try, park after 5.
				$this->markQueue($queueId, (int)$job['attempts'] >= 4 ? 'parked' : 'pending', $message, true);
				$this->saveState(['lastError' => "AI: $message", 'lastErrorAt' => $this->time->getTime()]);
				return 'skipped';
			}
			$this->saveState(['lastError' => "AI ($status): $message", 'lastErrorAt' => $this->time->getTime()]);
		}
		if ($status === 402) {
			if (!$ai) {
				$this->saveState(['lastError' => 'tollgate: budget exhausted (402)', 'lastErrorAt' => $this->time->getTime()]);
			}
			return 'budget';
		}
		if ($status === 401 || $status === 403) {
			if (!$ai) {
				$this->saveState(['lastError' => "tollgate refused the token ($status)", 'lastErrorAt' => $this->time->getTime()]);
			}
			return 'unauthorized';
		}
		if ($status >= 500 || $status === 429) {
			$this->markQueue($queueId, 'pending', "$who $status");
			if (!$ai) {
				$this->saveState(['lastError' => "Decisions API $status: " . mb_substr($body, 0, 200), 'lastErrorAt' => $this->time->getTime()]);
			}
			return 'transient';
		}
		if ($status >= 400) {
			$this->markQueue($queueId, (int)$job['attempts'] >= 4 ? 'parked' : 'pending', "$status: " . mb_substr($body, 0, 300), true);
			$this->saveState(['lastError' => "$who $status: " . mb_substr($body, 0, 200), 'lastErrorAt' => $this->time->getTime()]);
			return 'skipped';
		}

		$resp = json_decode($body, true);
		if (!is_array($resp)) {
			$this->markQueue($queueId, 'pending', 'Unreadable decisions response', true);
			return 'skipped';
		}
		$tokens = $resp['usage']['input_tokens'] ?? null;
		if ($ai && is_int($tokens)) {
			// The AI answers with a tool call: its output tokens cost too.
			$tokens += (int)($resp['usage']['output_tokens'] ?? 0);
		}
		if (!is_int($tokens)) {
			// Never count a call as free: estimate from the input size.
			$tokens = (int)ceil(mb_strlen($input) / 4);
			$this->saveState(['lastError' => 'Decisions response without usage; cost estimated', 'lastErrorAt' => $this->time->getTime()]);
		}
		$cost = $tokens / 1e6 * $s['pricePerMUsd'] * $s['usdToEur'];
		$sum = self::summarize($resp);
		$now = $this->time->getTime();

		$this->db->beginTransaction();
		try {
			$d = $this->db->getQueryBuilder();
			$d->delete('mail_triage')
				->where($d->expr()->eq('account_id', $d->createNamedParameter((int)$job['account_id'], IQueryBuilder::PARAM_INT)))
				->andWhere($d->expr()->eq('msg_hash', $d->createNamedParameter($job['msg_hash'])))
				->executeStatement();
			$i = $this->db->getQueryBuilder();
			$i->insert('mail_triage')->values([
				'account_id' => $i->createNamedParameter((int)$job['account_id'], IQueryBuilder::PARAM_INT),
				'msg_hash' => $i->createNamedParameter($job['msg_hash']),
				'version' => $i->createNamedParameter($qs['version']),
				'model' => $i->createNamedParameter(mb_substr((string)($resp['model'] ?? $qs['model']), 0, 64)),
				'category' => $i->createNamedParameter($sum['category']),
				'category_confidence' => $i->createNamedParameter($sum['category_confidence']),
				'urgency' => $i->createNamedParameter($sum['urgency']),
				'urgency_score' => $i->createNamedParameter($sum['urgency_score']),
				'needs_reply' => $i->createNamedParameter($sum['needs_reply']),
				'needs_action' => $i->createNamedParameter($sum['needs_action']),
				'has_deadline' => $i->createNamedParameter($sum['has_deadline']),
				'written_by_person' => $i->createNamedParameter($sum['written_by_person']),
				'suspicious' => $i->createNamedParameter($sum['suspicious']),
				'raw' => $i->createNamedParameter($body),
				'input_tokens' => $i->createNamedParameter($tokens, IQueryBuilder::PARAM_INT),
				'cost_eur' => $i->createNamedParameter($cost),
				'backfill' => $i->createNamedParameter((int)$job['priority'] === 0, IQueryBuilder::PARAM_BOOL),
				'classified_at' => $i->createNamedParameter($now, IQueryBuilder::PARAM_INT),
			])->executeStatement();
			$this->markQueue($queueId, 'done', null);
			$this->db->commit();
		} catch (Throwable $e) {
			$this->db->rollBack();
			throw $e;
		}
		if ($ai) {
			$this->saveState(['lastModel' => trim(($resp['providerLabel'] ?? $resp['provider'] ?? '') . ' · ' . ($resp['model'] ?? ''), ' ·')]);
		}
		return 'ok';
	}

	/**
	 * One mail to the Bun provider layer (server/agent/triage.ts), as the
	 * owner of the mail account: their AI settings and budget apply.
	 * @throws DoesNotExistException when the account is gone
	 */
	private function askAi(array $job, array $s, string $input, array $qs): \OCP\Http\Client\IResponse {
		$q = $this->db->getQueryBuilder();
		$uid = $q->select('user_id')->from('mail_accounts')
			->where($q->expr()->eq('id', $q->createNamedParameter((int)$job['account_id'], IQueryBuilder::PARAM_INT)))
			->executeQuery()->fetchOne();
		if (!is_string($uid) || $uid === '') {
			throw new DoesNotExistException('Mail account ' . $job['account_id'] . ' no longer exists');
		}
		return $this->clients->newClient()->post($s['serverUrl'] . '/agent/v1/internal/ai/triage', [
			'json' => ['uid' => $uid, 'input' => $input, 'questions' => $qs['questions'], 'version' => $qs['version']],
			'headers' => [\OC\Agent\InternalAuth::HEADER => \OCP\Server::get(\OC\Agent\InternalAuth::class)->expected()],
			'timeout' => 120,
			'http_errors' => false,
			// The Bun server is on the private network.
			'nextcloud' => ['allow_local_address' => true],
		]);
	}

	/**
	 * Decisions answers -> flat columns: choice = top value, predicate =
	 * probability, score = top label (+ score).
	 * @return array<string, string|float|null>
	 */
	public static function summarize(array $resp): array {
		$out = ['category' => null, 'category_confidence' => null, 'urgency' => null, 'urgency_score' => null,
			'needs_reply' => null, 'needs_action' => null, 'has_deadline' => null, 'written_by_person' => null, 'suspicious' => null];
		foreach ($resp['answers'] ?? [] as $a) {
			$name = $a['name'] ?? null;
			if (!is_string($name)) {
				continue;
			}
			$type = $a['type'] ?? '';
			if ($type === 'choice') {
				$out[$name] = $a['choice'] ?? null;
				$out[$name . '_confidence'] = isset($a['confidence']) ? (float)$a['confidence'] : null;
			} elseif ($type === 'predicate') {
				$out[$name] = isset($a['probability']) ? (float)$a['probability'] : null;
			} elseif ($type === 'score') {
				$top = null;
				foreach ($a['probabilities'] ?? [] as $p) {
					if ($top === null || ($p['probability'] ?? 0) > ($top['probability'] ?? 0)) {
						$top = $p;
					}
				}
				$out[$name] = $top['label'] ?? null;
				$out[$name . '_score'] = isset($a['score']) ? (float)$a['score'] : null;
			}
		}
		return array_intersect_key($out, array_flip(['category', 'category_confidence', 'urgency', 'urgency_score', 'needs_reply', 'needs_action', 'has_deadline', 'written_by_person', 'suspicious']));
	}

	/** The text the model sees: headers like a mail client shows them, then the body, cut to bodyChars. */
	private function buildInput(array $job, array $s): string {
		// Bodies are kept in Atrium: the mail server is asked once per mail.
		$stored = $this->loadBody((int)$job['account_id'], (string)$job['msg_hash']);
		if ($stored === null) {
			$stored = $this->fetchAndStoreBody($job);
		}
		$text = self::cleanText($stored['body']);
		if (mb_strlen($text) > $s['bodyChars']) {
			$text = mb_substr($text, 0, $s['bodyChars']) . "\n[...truncated]";
		}
		$input = implode("\n", [
			'Account: ' . $stored['account'],
			'Received: ' . gmdate(DATE_RFC2822, (int)$stored['sent_at']),
			'Classified at: ' . gmdate(DATE_ATOM, $this->time->getTime()),
			$stored['headers'],
			'List-Unsubscribe: ' . ($stored['has_unsubscribe'] ? 'yes' : 'no'),
			'Attachments: ' . ($stored['attachments'] ?: 'none'),
			'',
			$text,
		]);
		// Hard ceiling on what one mail can cost, whatever the headers hold.
		return mb_strlen($input) > self::MAX_INPUT_CHARS ? mb_substr($input, 0, self::MAX_INPUT_CHARS) . "\n[...truncated]" : $input;
	}

	private function loadBody(int $accountId, string $hash): ?array {
		$q = $this->db->getQueryBuilder();
		$r = $q->select('headers', 'body', 'attachments', 'has_unsubscribe', 'sent_at')->from('mail_bodies')
			->where($q->expr()->eq('account_id', $q->createNamedParameter($accountId, IQueryBuilder::PARAM_INT)))
			->andWhere($q->expr()->eq('msg_hash', $q->createNamedParameter($hash)))
			->executeQuery()->fetch();
		if ($r === false) {
			return null;
		}
		$r['account'] = $this->accounts->findById($accountId)->getEmail();
		$r['has_unsubscribe'] = (bool)$r['has_unsubscribe'];
		return $r;
	}

	/** Fetch one mail from the server and keep its readable text (no attachments, no images). */
	private function fetchAndStoreBody(array $job): array {
		$qb = $this->db->getQueryBuilder();
		$m = $qb->select('id', 'mailbox_id', 'uid')->from('mail_messages')
			->where($qb->expr()->eq('id', $qb->createNamedParameter((int)$job['db_id'], IQueryBuilder::PARAM_INT)))
			->executeQuery()->fetch();
		if ($m === false) {
			throw new DoesNotExistException('mail_messages row ' . $job['db_id']);
		}
		if ((int)$m['uid'] < 1) {
			// Kept only in Atrium (gone from the server) and no text was stored.
			throw new DoesNotExistException('mail is no longer on the mail server and its text was never stored');
		}
		$mailbox = $this->mailboxes->findById((int)$m['mailbox_id']);
		$account = $this->accounts->findById($mailbox->getAccountId());
		$client = $this->imap[$account->getId()] ??= $this->imapFactory->getClient($account);
		try {
			$msg = $this->mailManager->getImapMessage($client, $account, $mailbox, (int)$m['uid'], true);
		} catch (Throwable $e) {
			// Drop a broken connection; the next mail logs in again.
			unset($this->imap[$account->getId()]);
			try { $client->logout(); } catch (Throwable) {}
			throw $e;
		}
		return $this->storeBody($account, $mailbox, $msg, (string)$job['msg_hash']);
	}

	/**
	 * Keep the readable text of a fetched mail (headers + plain body; no attachments,
	 * no images). Called after classification fetches and whenever a mail is opened.
	 *
	 * @return array{headers: string, body: string, attachments: string, has_unsubscribe: bool, sent_at: int, account: string}
	 */
	public function storeBody(\OCA\Mail\Account $account, \OCA\Mail\Db\Mailbox $mailbox, \OCA\Mail\Model\IMAPMessage $msg, string $hash, ?array $reader = null): array {
		$text = $msg->getPlainBody();
		if (trim($text) === '' && $msg->hasHtmlMessage()) {
			$text = (string)Horde_Text_Filter::filter($msg->htmlMessage, 'Html2text', ['charset' => 'UTF-8', 'width' => 0]);
		}
		$text = mb_substr(self::stripInvisible($text), 0, self::MAX_STORED_CHARS);
		$addr = static fn ($list) => implode(', ', array_map(static fn ($a) => trim(($a['label'] ?? '') !== ($a['email'] ?? '') ? ($a['label'] ?? '') . ' <' . ($a['email'] ?? '') . '>' : ($a['email'] ?? '')), $list->jsonSerialize()));
		$row = [
			'headers' => implode("\n", [
				'From: ' . $addr($msg->getFrom()),
				'To: ' . $addr($msg->getTo()),
				'Cc: ' . $addr($msg->getCC()),
				'Subject: ' . $msg->getSubject(),
				'Folder: ' . $mailbox->getName(),
			]),
			'body' => $text,
			'attachments' => implode(', ', array_map(static fn ($a) => ($a['fileName'] ?? 'unnamed') . ' (' . ($a['mime'] ?? '?') . ', ' . ($a['size'] ?? 0) . ' B)', $msg->getAttachments())),
			'has_unsubscribe' => $msg->getUnsubscribeUrl() !== null,
			'sent_at' => $msg->getSentDate()->getTimestamp(),
		];
		try {
			$i = $this->db->getQueryBuilder();
			$i->insert('mail_bodies')->values([
				'account_id' => $i->createNamedParameter($account->getId(), IQueryBuilder::PARAM_INT),
				'msg_hash' => $i->createNamedParameter($hash),
				'headers' => $i->createNamedParameter($row['headers']),
				'body' => $i->createNamedParameter($row['body']),
				'attachments' => $i->createNamedParameter($row['attachments']),
				'has_unsubscribe' => $i->createNamedParameter($row['has_unsubscribe'], IQueryBuilder::PARAM_BOOL),
				'sent_at' => $i->createNamedParameter($row['sent_at'], IQueryBuilder::PARAM_INT),
				'fetched_at' => $i->createNamedParameter($this->time->getTime(), IQueryBuilder::PARAM_INT),
			])->executeStatement();
		} catch (Throwable) {
			// Another worker stored it first.
		}
		if ($reader !== null) {
			$this->storeReaderCopy($account->getId(), $hash, $reader);
		}
		$row['account'] = $account->getEmail();
		return $row;
	}

	/** Cap on one stored reader body (sanitized HTML); bigger mails are read from the server. */
	public const MAX_READER_CHARS = 2000000;

	/**
	 * Keep what the reader shows (IMAPMessage::getFullMessage output: sanitized body,
	 * remote images still blocked, attachment names only), so the next open needs
	 * no mail server. Fills rows stored earlier with text only.
	 *
	 *  array<string, mixed> $reader
	 */
	public function storeReaderCopy(int $accountId, string $hash, array $reader): void {
		$body = (string)($reader['body'] ?? '');
		if (mb_strlen($body) > self::MAX_READER_CHARS) {
			return;
		}
		unset($reader['body']);
		// Per-row data that the controller adds again on every open.
		foreach (['accountId', 'mailboxId', 'databaseId', 'isSenderTrusted', 'smime', 'dkimValid', 'itineraries', 'uid', 'flags'] as $k) {
			unset($reader[$k]);
		}
		$meta = json_encode($reader, JSON_INVALID_UTF8_SUBSTITUTE);
		if ($meta === false) {
			return;
		}
		try {
			$u = $this->db->getQueryBuilder();
			$u->update('mail_bodies')
				->set('reader_body', $u->createNamedParameter(self::stripNul($body)))
				->set('reader_meta', $u->createNamedParameter($meta))
				->where($u->expr()->eq('account_id', $u->createNamedParameter($accountId, IQueryBuilder::PARAM_INT)))
				->andWhere($u->expr()->eq('msg_hash', $u->createNamedParameter($hash)))
				->executeStatement();
		} catch (Throwable $e) {
			$this->logger->warning('Could not keep the reader copy of a mail: ' . $e->getMessage());
		}
	}

	private static function stripNul(string $s): string {
		return str_replace("\0", '', $s);
	}

	/**
	 * Atrium's copy of one mail for the reader, or null when nothing is stored.
	 *
	 *  array{headers: string, body: string, attachments: string, sent_at: int, fetched_at: int, reader_body: ?string, reader_meta: ?array<string, mixed>}|null
	 */
	public function loadCopy(int $accountId, string $hash): ?array {
		$q = $this->db->getQueryBuilder();
		$r = $q->select('headers', 'body', 'attachments', 'sent_at', 'fetched_at', 'reader_body', 'reader_meta')->from('mail_bodies')
			->where($q->expr()->eq('account_id', $q->createNamedParameter($accountId, IQueryBuilder::PARAM_INT)))
			->andWhere($q->expr()->eq('msg_hash', $q->createNamedParameter($hash)))
			->executeQuery()->fetch();
		if ($r === false) {
			return null;
		}
		$meta = $r['reader_meta'] === null ? null : json_decode((string)$r['reader_meta'], true);
		return [
			'headers' => (string)$r['headers'], 'body' => (string)$r['body'], 'attachments' => (string)$r['attachments'],
			'sent_at' => (int)$r['sent_at'], 'fetched_at' => (int)$r['fetched_at'],
			'reader_body' => $r['reader_body'] === null ? null : (string)$r['reader_body'],
			'reader_meta' => is_array($meta) ? $meta : null,
		];
	}

	/** Attachments downloaded of this mail (names only), for the reader of a mail that left the server. */
	public function storedAttachments(int $accountId, ?string $messageId, int $dbId): array {
		return (new \OCA\Mail\Service\StoredAttachments($this->db))->listFor($accountId, self::hash($messageId, $dbId));
	}

	/** Cap on one stored body, against absurd mails. */
	public const MAX_STORED_CHARS = 200000;

	private static function stripInvisible(string $text): string {
		$text = preg_replace('/[\x{034F}\x{00AD}\x{200B}-\x{200F}\x{2028}\x{2029}\x{202A}-\x{202E}\x{2060}-\x{2064}\x{FEFF}\x{180E}]/u', '', $text) ?? $text;
		return trim(preg_replace("/[ \t]+\n/", "\n", preg_replace("/\n{3,}/", "\n\n", $text) ?? $text) ?? $text);
	}

	public const MAX_INPUT_CHARS = 8000;

	/**
	 * Only the readable words go to the model: links become their domain,
	 * invisible preheader filler and base64-like runs are dropped.
	 */
	public static function cleanText(string $text): string {
		$text = preg_replace_callback('~(?:https?://|www\.)[^\s<>()"\]]+~i', static function ($m) {
			$host = parse_url(str_starts_with(strtolower($m[0]), 'www.') ? 'http://' . $m[0] : $m[0], PHP_URL_HOST);
			return is_string($host) ? '[link: ' . preg_replace('/^www\./i', '', $host) . ']' : '[link]';
		}, $text) ?? $text;
		// Zero-width / invisible characters newsletters pad previews with.
		$text = preg_replace('/[\x{034F}\x{00AD}\x{200B}-\x{200F}\x{2028}\x{2029}\x{202A}-\x{202E}\x{2060}-\x{2064}\x{FEFF}\x{180E}]/u', '', $text) ?? $text;
		$text = preg_replace('~[A-Za-z0-9+/=_-]{60,}~', '[data]', $text) ?? $text;
		$text = preg_replace('/[ \t\x{00A0}]+/u', ' ', $text) ?? $text;
		$text = preg_replace('/ ?\n ?/', "\n", $text) ?? $text;
		$text = preg_replace("/\n{3,}/", "\n\n", $text) ?? $text;
		return trim($text);
	}

	/**
	 * Ids of the user's classified mails in the given folders that match a label
	 * filter, newest first. The caller loads the messages themselves.
	 *
	 * @param int[] $mailboxIds
	 * @param string[] $categories empty = any
	 * @return int[]
	 */
	public function idsByLabel(string $userId, array $mailboxIds, array $categories, bool $needsAction, ?int $cursor, int $limit, array $exclude = []): array {
		if ($mailboxIds === []) {
			return [];
		}
		$qb = $this->db->getQueryBuilder();
		$qb->select('m.id')->from('mail_messages', 'm')
			->join('m', 'mail_mailboxes', 'mb', $qb->expr()->eq('mb.id', 'm.mailbox_id'))
			->join('mb', 'mail_accounts', 'a', $qb->expr()->andX(
				$qb->expr()->eq('a.id', 'mb.account_id'),
				$qb->expr()->eq('a.user_id', $qb->createNamedParameter($userId)),
			))
			// Same mail = same account + Message-ID hash, so the result follows the mail
			// through resyncs and moves (db ids change, the hash does not).
			->leftJoin('a', 'mail_triage', 't', $qb->expr()->andX(
				$qb->expr()->eq('t.account_id', 'a.id'),
				$qb->expr()->eq('t.msg_hash', $qb->createFunction('MD5(m.message_id)')),
			))
			->where($qb->expr()->in('m.mailbox_id', $qb->createNamedParameter($mailboxIds, IQueryBuilder::PARAM_INT_ARRAY)))
			->andWhere($qb->expr()->eq('m.flag_deleted', $qb->createNamedParameter(false, IQueryBuilder::PARAM_BOOL)))
			->orderBy('m.sent_at', 'DESC')
			->setMaxResults(max(1, min(100, $limit)));
		if ($categories !== []) {
			$qb->andWhere($qb->expr()->in('t.category', $qb->createNamedParameter($categories, IQueryBuilder::PARAM_STR_ARRAY)));
		}
		if ($exclude !== []) {
			// Mail the classifier has not seen yet stays visible.
			$qb->andWhere($qb->expr()->orX($qb->expr()->isNull('t.category'), $qb->expr()->notIn('t.category', $qb->createNamedParameter($exclude, IQueryBuilder::PARAM_STR_ARRAY))));
		}
		if ($needsAction) {
			$qb->andWhere($qb->expr()->gte('t.needs_action', $qb->createNamedParameter(0.5, IQueryBuilder::PARAM_STR)));
		}
		if ($cursor !== null) {
			$qb->andWhere($qb->expr()->lt('m.sent_at', $qb->createNamedParameter($cursor, IQueryBuilder::PARAM_INT)));
		}
		return array_map('intval', $qb->executeQuery()->fetchAll(\PDO::FETCH_COLUMN));
	}

	/**
	 * Ids of the user's recent mail that Wavium calls important (same bar as the
	 * morning digest): needs a reply or an action (>= 0.5), or urgent now/today;
	 * never spam or suspicious, never in the excluded folders (junk, trash).
	 * Newest first. Used by the Dashboard's "Important mail" widget (V4-1).
	 *
	 * @param int[] $excludeMailboxIds
	 * @return int[]
	 */
	public function importantIds(string $userId, array $excludeMailboxIds, int $since, int $limit): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('m.id')->from('mail_messages', 'm')
			->join('m', 'mail_mailboxes', 'mb', $qb->expr()->eq('mb.id', 'm.mailbox_id'))
			->join('mb', 'mail_accounts', 'a', $qb->expr()->andX(
				$qb->expr()->eq('a.id', 'mb.account_id'),
				$qb->expr()->eq('a.user_id', $qb->createNamedParameter($userId)),
			))
			->join('a', 'mail_triage', 't', $qb->expr()->andX(
				$qb->expr()->eq('t.account_id', 'a.id'),
				$qb->expr()->eq('t.msg_hash', $qb->createFunction('MD5(m.message_id)')),
			))
			->where($qb->expr()->eq('m.flag_deleted', $qb->createNamedParameter(false, IQueryBuilder::PARAM_BOOL)))
			->andWhere($qb->expr()->gte('m.sent_at', $qb->createNamedParameter($since, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->orX(
				$qb->expr()->gte('t.needs_reply', $qb->createNamedParameter(0.5, IQueryBuilder::PARAM_STR)),
				$qb->expr()->gte('t.needs_action', $qb->createNamedParameter(0.5, IQueryBuilder::PARAM_STR)),
				$qb->expr()->in('t.urgency', $qb->createNamedParameter(['now', 'today'], IQueryBuilder::PARAM_STR_ARRAY)),
			))
			->andWhere($qb->expr()->orX($qb->expr()->isNull('t.category'), $qb->expr()->neq('t.category', $qb->createNamedParameter('spam'))))
			->andWhere($qb->expr()->orX($qb->expr()->isNull('t.suspicious'), $qb->expr()->lt('t.suspicious', $qb->createNamedParameter(0.6, IQueryBuilder::PARAM_STR))))
			->orderBy('m.sent_at', 'DESC')
			->setMaxResults(max(1, min(50, $limit)));
		if ($excludeMailboxIds !== []) {
			$qb->andWhere($qb->expr()->notIn('m.mailbox_id', $qb->createNamedParameter($excludeMailboxIds, IQueryBuilder::PARAM_INT_ARRAY)));
		}
		return array_map('intval', $qb->executeQuery()->fetchAll(\PDO::FETCH_COLUMN));
	}

	/**
	 * Classifications for mail_messages ids (as listed in a folder).
	 * @param int[] $dbIds
	 * @return array<int, array<string, mixed>> db id => summary
	 */
	public function forMessages(string $userId, array $dbIds): array {
		if ($dbIds === []) {
			return [];
		}
		$qb = $this->db->getQueryBuilder();
		$rows = $qb->select('m.id', 'm.message_id', 'b.account_id')
			->from('mail_messages', 'm')
			->join('m', 'mail_mailboxes', 'b', $qb->expr()->eq('m.mailbox_id', 'b.id'))
			->join('b', 'mail_accounts', 'a', $qb->expr()->eq('b.account_id', 'a.id'))
			->where($qb->expr()->in('m.id', $qb->createNamedParameter(array_slice($dbIds, 0, 500), IQueryBuilder::PARAM_INT_ARRAY)))
			->andWhere($qb->expr()->eq('a.user_id', $qb->createNamedParameter($userId)))
			->executeQuery()->fetchAll();
		$byKey = [];
		foreach ($rows as $r) {
			$byKey[$r['account_id'] . ':' . self::hash($r['message_id'], (int)$r['id'])][] = (int)$r['id'];
		}
		if ($byKey === []) {
			return [];
		}
		$hashes = array_values(array_unique(array_map(static fn ($k) => explode(':', $k, 2)[1], array_keys($byKey))));
		$q = $this->db->getQueryBuilder();
		$found = $q->select('account_id', 'msg_hash', 'category', 'category_confidence', 'urgency', 'urgency_score', 'needs_reply', 'needs_action', 'has_deadline', 'written_by_person', 'suspicious', 'classified_at')
			->from('mail_triage')
			->where($q->expr()->in('msg_hash', $q->createNamedParameter($hashes, IQueryBuilder::PARAM_STR_ARRAY)))
			->executeQuery()->fetchAll();
		$out = [];
		foreach ($found as $f) {
			foreach ($byKey[$f['account_id'] . ':' . $f['msg_hash']] ?? [] as $id) {
				$out[$id] = self::publicRow($f);
			}
		}
		// Queue state for every listed mail: done | pending | parked | none (not queued: other folders).
		$q = $this->db->getQueryBuilder();
		$queued = $q->select('account_id', 'msg_hash', 'status', 'attempts', 'last_error')
			->from('mail_triage_queue')
			->where($q->expr()->in('msg_hash', $q->createNamedParameter($hashes, IQueryBuilder::PARAM_STR_ARRAY)))
			->executeQuery()->fetchAll();
		$queueOf = [];
		foreach ($queued as $r) {
			$queueOf[$r['account_id'] . ':' . $r['msg_hash']] = $r;
		}
		foreach ($byKey as $key => $ids) {
			$r = $queueOf[$key] ?? null;
			foreach ($ids as $id) {
				$out[$id] = ($out[$id] ?? self::publicRow([])) + [
					'queue' => $r === null ? 'none' : (string)$r['status'],
					'attempts' => $r === null ? 0 : (int)$r['attempts'],
					'error' => $r === null ? null : $r['last_error'],
				];
			}
		}
		return $out;
	}

	/**
	 * Put one of the user's mails (any folder) at the front of the queue and,
	 * when the pipeline may run, classify it right away.
	 * @return array{queued: bool, classified: bool, reason: ?string, triage: ?array<string, mixed>}
	 */
	public function reclassify(string $userId, int $dbId): array {
		$qb = $this->db->getQueryBuilder();
		$r = $qb->select('m.id', 'm.message_id', 'm.sent_at', 'b.account_id')
			->from('mail_messages', 'm')
			->join('m', 'mail_mailboxes', 'b', $qb->expr()->eq('m.mailbox_id', 'b.id'))
			->join('b', 'mail_accounts', 'a', $qb->expr()->eq('b.account_id', 'a.id'))
			->where($qb->expr()->eq('m.id', $qb->createNamedParameter($dbId, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->eq('a.user_id', $qb->createNamedParameter($userId)))
			->executeQuery()->fetch();
		if ($r === false) {
			throw new DoesNotExistException("message $dbId");
		}
		$accountId = (int)$r['account_id'];
		$hash = self::hash($r['message_id'], $dbId);
		$now = $this->time->getTime();
		$u = $this->db->getQueryBuilder();
		// Priority 2: ahead of new mail, and never counted as backlog.
		$n = $u->update('mail_triage_queue')
			->set('status', $u->createNamedParameter('pending'))
			->set('priority', $u->createNamedParameter(2, IQueryBuilder::PARAM_INT))
			->set('attempts', $u->createNamedParameter(0, IQueryBuilder::PARAM_INT))
			->set('last_error', $u->createNamedParameter(null))
			->set('db_id', $u->createNamedParameter($dbId, IQueryBuilder::PARAM_INT))
			->set('updated_at', $u->createNamedParameter($now, IQueryBuilder::PARAM_INT))
			->where($u->expr()->eq('account_id', $u->createNamedParameter($accountId, IQueryBuilder::PARAM_INT)))
			->andWhere($u->expr()->eq('msg_hash', $u->createNamedParameter($hash)))
			->executeStatement();
		if ($n === 0) {
			$i = $this->db->getQueryBuilder();
			$i->insert('mail_triage_queue')->values([
				'account_id' => $i->createNamedParameter($accountId, IQueryBuilder::PARAM_INT),
				'msg_hash' => $i->createNamedParameter($hash),
				'db_id' => $i->createNamedParameter($dbId, IQueryBuilder::PARAM_INT),
				'priority' => $i->createNamedParameter(2, IQueryBuilder::PARAM_INT),
				'sent_at' => $i->createNamedParameter((int)$r['sent_at'], IQueryBuilder::PARAM_INT),
				'status' => $i->createNamedParameter('pending'),
				'enqueued_at' => $i->createNamedParameter($now, IQueryBuilder::PARAM_INT),
				'updated_at' => $i->createNamedParameter($now, IQueryBuilder::PARAM_INT),
			])->executeStatement();
		}

		$s = $this->settings();
		$reason = null;
		if (!$s['enabled']) {
			$reason = 'Classification is off; the mail is queued.';
		} elseif (!$s['configured']) {
			$reason = 'Classification is not configured; the mail is queued.';
		} elseif (($this->state()['state'] ?? '') === 'not_configured' && (int)($this->state()['pausedUntil'] ?? 0) > $now) {
			$reason = 'No AI is set up for classification (Settings > AI); the mail is queued.';
		} elseif ((int)($this->state()['pausedUntil'] ?? 0) > $now) {
			$reason = 'Classification is paused; the mail runs when it resumes.';
		} elseif ($this->spentToday()['total'] >= $s['capTotal']) {
			$reason = 'Today’s budget is used; the mail runs tomorrow.';
		}
		$classified = false;
		if ($reason === null) {
			$q = $this->db->getQueryBuilder();
			$job = $q->select('*')->from('mail_triage_queue')
				->where($q->expr()->eq('account_id', $q->createNamedParameter($accountId, IQueryBuilder::PARAM_INT)))
				->andWhere($q->expr()->eq('msg_hash', $q->createNamedParameter($hash)))
				->executeQuery()->fetch();
			$token = $this->appConfig->getValueString(Application::APP_ID, 'triage_tollgate_token', '');
			try {
				$result = $this->classifyOne($job, $s, $this->questions(), $token);
			} finally {
				$this->closeConnections();
			}
			$classified = $result === 'ok';
			if ($classified) {
				$this->saveState(['lastOk' => $this->time->getTime()]);
			} else {
				$reason = $this->state()['lastError'] ?? 'Classification failed; it will be retried.';
			}
		}
		return ['queued' => true, 'classified' => $classified, 'reason' => $reason, 'triage' => $this->forMessages($userId, [$dbId])[$dbId] ?? null];
	}

	/** @return array<string, mixed> */
	private static function publicRow(array $f): array {
		$num = static fn ($v) => $v === null ? null : round((float)$v, 3);
		$f += array_fill_keys(['category', 'category_confidence', 'urgency', 'urgency_score', 'needs_reply', 'needs_action', 'has_deadline', 'written_by_person', 'suspicious', 'classified_at'], null);
		return [
			'category' => $f['category'], 'categoryConfidence' => $num($f['category_confidence']),
			'urgency' => $f['urgency'], 'urgencyScore' => $num($f['urgency_score']),
			'needsReply' => $num($f['needs_reply']), 'needsAction' => $num($f['needs_action']),
			'hasDeadline' => $num($f['has_deadline']), 'writtenByPerson' => $num($f['written_by_person']),
			'suspicious' => $num($f['suspicious']), 'classifiedAt' => $f['classified_at'] === null ? null : (int)$f['classified_at'],
		];
	}

	/**
	 * Everything the status page shows, for the user's accounts.
	 * @return array<string, mixed>
	 */
	public function status(string $userId): array {
		$accounts = $this->accounts->findByUserId($userId);
		$ids = array_map(static fn (Account $a) => $a->getId(), $accounts);
		$s = $this->settings();
		$now = $this->time->getTime();

		$queue = [];
		$perAccount = [];
		if ($ids !== []) {
			$qb = $this->db->getQueryBuilder();
			foreach ($qb->select('account_id', 'status', 'priority')->selectAlias($qb->func()->count('*'), 'n')
				->from('mail_triage_queue')
				->where($qb->expr()->in('account_id', $qb->createNamedParameter($ids, IQueryBuilder::PARAM_INT_ARRAY)))
				->groupBy('account_id', 'status', 'priority')->executeQuery()->fetchAll() as $r) {
				$key = $r['status'] === 'pending' ? ((int)$r['priority'] === 1 ? 'pendingNew' : 'pendingBacklog') : $r['status'];
				$queue[$key] = ($queue[$key] ?? 0) + (int)$r['n'];
				$perAccount[(int)$r['account_id']][$key] = ($perAccount[(int)$r['account_id']][$key] ?? 0) + (int)$r['n'];
			}
		}

		$categories = [];
		$flowRows = [];
		$urgency = [];
		$recent = [];
		$parked = [];
		$spentMonth = 0.0;
		$daily = [];
		if ($ids !== []) {
			$qb = $this->db->getQueryBuilder();
			foreach ($qb->select('category')->selectAlias($qb->func()->count('*'), 'n')->from('mail_triage')
				->where($qb->expr()->in('account_id', $qb->createNamedParameter($ids, IQueryBuilder::PARAM_INT_ARRAY)))
				->groupBy('category')->executeQuery()->fetchAll() as $r) {
				$categories[] = ['category' => $r['category'] ?? 'unknown', 'count' => (int)$r['n']];
			}
			// Mail flow per address (v4): category x important, for the status page's flow chart.
			// Important = needs a reply or an action (same 0.5 bar as the digest) or due today/now.
			$qb = $this->db->getQueryBuilder();
			foreach ($qb->select('account_id', 'category', 'urgency', 'needs_reply', 'needs_action')->selectAlias($qb->func()->count('*'), 'n')->from('mail_triage')
				->where($qb->expr()->in('account_id', $qb->createNamedParameter($ids, IQueryBuilder::PARAM_INT_ARRAY)))
				->groupBy('account_id', 'category', 'urgency', 'needs_reply', 'needs_action')->executeQuery()->fetchAll() as $r) {
				$important = (float)($r['needs_reply'] ?? 0) >= 0.5 || (float)($r['needs_action'] ?? 0) >= 0.5 || in_array($r['urgency'], ['now', 'today'], true);
				$key = $r['account_id'] . '|' . ($r['category'] ?? 'unknown') . '|' . ($important ? 1 : 0);
				$flowRows[$key] ??= ['accountId' => (int)$r['account_id'], 'category' => $r['category'] ?? 'unknown', 'important' => $important, 'count' => 0];
				$flowRows[$key]['count'] += (int)$r['n'];
			}
			$qb = $this->db->getQueryBuilder();
			foreach ($qb->select('urgency')->selectAlias($qb->func()->count('*'), 'n')->from('mail_triage')
				->where($qb->expr()->in('account_id', $qb->createNamedParameter($ids, IQueryBuilder::PARAM_INT_ARRAY)))
				->groupBy('urgency')->executeQuery()->fetchAll() as $r) {
				$urgency[] = ['urgency' => $r['urgency'] ?? 'unknown', 'count' => (int)$r['n']];
			}

			// Last 14 days of spend and volume, by local day.
			$tz = new \DateTimeZone($s['timezone']);
			$since = (new \DateTimeImmutable('today', $tz))->modify('-13 days')->getTimestamp();
			$monthStart = (new \DateTimeImmutable('first day of this month midnight', $tz))->getTimestamp();
			$qb = $this->db->getQueryBuilder();
			foreach ($qb->select('classified_at', 'cost_eur', 'backfill')->from('mail_triage')
				->where($qb->expr()->gte('classified_at', $qb->createNamedParameter(min($since, $monthStart), IQueryBuilder::PARAM_INT)))
				->andWhere($qb->expr()->in('account_id', $qb->createNamedParameter($ids, IQueryBuilder::PARAM_INT_ARRAY)))
				->executeQuery()->fetchAll() as $r) {
				$at = (int)$r['classified_at'];
				if ($at >= $monthStart) {
					$spentMonth += (float)$r['cost_eur'];
				}
				if ($at >= $since) {
					$day = (new \DateTimeImmutable('@' . $at))->setTimezone($tz)->format('Y-m-d');
					$daily[$day] ??= ['day' => $day, 'count' => 0, 'eur' => 0.0];
					$daily[$day]['count']++;
					$daily[$day]['eur'] += (float)$r['cost_eur'];
				}
			}
			ksort($daily);

			$qb = $this->db->getQueryBuilder();
			foreach ($qb->select('t.category', 't.urgency', 't.needs_reply', 't.needs_action', 't.suspicious', 't.classified_at', 't.cost_eur', 't.input_tokens', 'm.subject', 'm.id')
				->from('mail_triage', 't')
				->join('t', 'mail_triage_queue', 'q', $qb->expr()->andX($qb->expr()->eq('q.account_id', 't.account_id'), $qb->expr()->eq('q.msg_hash', 't.msg_hash')))
				->leftJoin('q', 'mail_messages', 'm', $qb->expr()->eq('m.id', 'q.db_id'))
				->where($qb->expr()->in('t.account_id', $qb->createNamedParameter($ids, IQueryBuilder::PARAM_INT_ARRAY)))
				->orderBy('t.classified_at', 'DESC')->setMaxResults(15)->executeQuery()->fetchAll() as $r) {
				$recent[] = ['subject' => $r['subject'], 'messageId' => $r['id'] === null ? null : (int)$r['id'], 'category' => $r['category'], 'urgency' => $r['urgency'],
					'needsReply' => $r['needs_reply'] === null ? null : round((float)$r['needs_reply'], 2), 'needsAction' => $r['needs_action'] === null ? null : round((float)$r['needs_action'], 2),
					'suspicious' => $r['suspicious'] === null ? null : round((float)$r['suspicious'], 2),
					'classifiedAt' => (int)$r['classified_at'], 'costEur' => (float)$r['cost_eur'], 'tokens' => (int)$r['input_tokens']];
			}

			$qb = $this->db->getQueryBuilder();
			foreach ($qb->select('q.last_error', 'q.attempts', 'q.updated_at', 'q.status', 'm.subject', 'm.id')
				->from('mail_triage_queue', 'q')
				->leftJoin('q', 'mail_messages', 'm', $qb->expr()->eq('m.id', 'q.db_id'))
				->where($qb->expr()->in('q.account_id', $qb->createNamedParameter($ids, IQueryBuilder::PARAM_INT_ARRAY)))
				->andWhere($qb->expr()->isNotNull('q.last_error'))
				->orderBy('q.updated_at', 'DESC')->setMaxResults(10)->executeQuery()->fetchAll() as $r) {
				$parked[] = ['subject' => $r['subject'], 'messageId' => $r['id'] === null ? null : (int)$r['id'], 'status' => $r['status'], 'attempts' => (int)$r['attempts'], 'error' => $r['last_error'], 'at' => (int)$r['updated_at']];
			}
		}

		// Sync side of the pipeline: folders, cached state, prepared previews.
		$folders = [];
		if ($ids !== []) {
			$qb = $this->db->getQueryBuilder();
			$boxes = $qb->select('id', 'account_id', 'name', 'special_use', 'messages', 'unseen', 'sync_new_token', 'sync_new_lock', 'sync_changed_lock', 'sync_vanished_lock', 'sync_in_background')
				->from('mail_mailboxes')
				->where($qb->expr()->in('account_id', $qb->createNamedParameter($ids, IQueryBuilder::PARAM_INT_ARRAY)))
				->orderBy('account_id')->addOrderBy('name')->executeQuery()->fetchAll();
			$qb = $this->db->getQueryBuilder();
			$counts = [];
			foreach ($qb->select('mailbox_id', 'structure_analyzed')->selectAlias($qb->func()->count('*'), 'n')->selectAlias($qb->func()->count('server_gone_at'), 'kept')->from('mail_messages')
				->groupBy('mailbox_id', 'structure_analyzed')->executeQuery()->fetchAll() as $r) {
				$counts[(int)$r['mailbox_id']][$r['structure_analyzed'] ? 'analyzed' : 'raw'] = (int)$r['n'];
				$counts[(int)$r['mailbox_id']]['kept'] = ($counts[(int)$r['mailbox_id']]['kept'] ?? 0) + (int)$r['kept'];
			}
			// Our copy per folder: mails queued for classification, classified, and with a stored body.
			$qb = $this->db->getQueryBuilder();
			$mine = [];
			foreach ($qb->select('m.mailbox_id', 'q.status')->selectAlias($qb->func()->count('*'), 'n')->selectAlias($qb->func()->count('b.id'), 'bodies')
				->from('mail_messages', 'm')
				->join('m', 'mail_triage_queue', 'q', $qb->expr()->eq('q.db_id', 'm.id'))
				->leftJoin('q', 'mail_bodies', 'b', $qb->expr()->andX($qb->expr()->eq('b.account_id', 'q.account_id'), $qb->expr()->eq('b.msg_hash', 'q.msg_hash')))
				->groupBy('m.mailbox_id', 'q.status')->executeQuery()->fetchAll() as $r) {
				$k = (int)$r['mailbox_id'];
				$mine[$k]['queued'] = ($mine[$k]['queued'] ?? 0) + (int)$r['n'];
				$mine[$k]['bodies'] = ($mine[$k]['bodies'] ?? 0) + (int)$r['bodies'];
				if ($r['status'] === 'done') {
					$mine[$k]['classified'] = (int)$r['n'];
				}
			}
			foreach ($boxes as $b) {
				$c = $counts[(int)$b['id']] ?? [];
				$lock = max((int)$b['sync_new_lock'], (int)$b['sync_changed_lock'], (int)$b['sync_vanished_lock']);
				$folders[] = [
					'id' => (int)$b['id'], 'accountId' => (int)$b['account_id'], 'name' => $b['name'],
					'specialUse' => json_decode((string)$b['special_use'], true) ?: [],
					'serverMessages' => (int)$b['messages'], 'serverUnread' => (int)$b['unseen'],
					'cached' => $b['sync_new_token'] !== null, 'syncing' => $lock > $now - 300,
					'stored' => ($c['analyzed'] ?? 0) + ($c['raw'] ?? 0), 'previews' => $c['analyzed'] ?? 0,
					// Rows kept after the server stopped holding them (part of 'stored', not of 'serverMessages').
					'kept' => $c['kept'] ?? 0,
					'queued' => $mine[(int)$b['id']]['queued'] ?? 0, 'classified' => $mine[(int)$b['id']]['classified'] ?? 0, 'bodies' => $mine[(int)$b['id']]['bodies'] ?? 0,
				];
			}
		}

		// Our copy against the mail server, per account (distinct mails by Message-ID):
		// on the server (with or without stored text), and only in Atrium: list rows kept
		// after the server stopped holding them (server_gone_at) plus stored texts whose
		// list row is gone (mail removed before Atrium kept list rows, 2026-11-01).
		$copy = [];
		if ($ids !== []) {
			$inList = []; $withBody = []; $bodies = []; $kept = []; $keptText = []; $anyRowBody = [];
			$distinct = function (bool $gone, bool $withText) {
				$qb = $this->db->getQueryBuilder();
				$qb->select('mb.account_id')->selectAlias($qb->createFunction('COUNT(DISTINCT m.message_id)'), 'n')
					->from('mail_messages', 'm')->join('m', 'mail_mailboxes', 'mb', $qb->expr()->eq('mb.id', 'm.mailbox_id'))
					->where($qb->expr()->isNotNull('m.message_id'))->andWhere($qb->expr()->neq('m.message_id', $qb->createNamedParameter('')))
					->andWhere($gone ? $qb->expr()->isNotNull('m.server_gone_at') : $qb->expr()->isNull('m.server_gone_at'));
				if ($withText) {
					$qb->join('mb', 'mail_bodies', 'b', $qb->expr()->andX($qb->expr()->eq('b.account_id', 'mb.account_id'), $qb->expr()->eq('b.msg_hash', $qb->createFunction('MD5(m.message_id)'))));
				}
				$out = [];
				foreach ($qb->groupBy('mb.account_id')->executeQuery()->fetchAll() as $r) {
					$out[(int)$r['account_id']] = (int)$r['n'];
				}
				return $out;
			};
			$inList = $distinct(false, false);
			$withBody = $distinct(false, true);
			$kept = $distinct(true, false);
			$keptText = $distinct(true, true);
			$qb = $this->db->getQueryBuilder();
			foreach ($qb->select('account_id')->selectAlias($qb->func()->count('*'), 'n')->from('mail_bodies')->groupBy('account_id')->executeQuery()->fetchAll() as $r) {
				$bodies[(int)$r['account_id']] = (int)$r['n'];
			}
			foreach ($ids as $aid) {
				$l = $inList[$aid] ?? 0; $w = $withBody[$aid] ?? 0; $b = $bodies[$aid] ?? 0; $k = $kept[$aid] ?? 0; $kt = $keptText[$aid] ?? 0;
				// Texts without any list row (on the server or kept).
				$orphanTexts = max(0, $b - $w - $kt);
				$copy[] = ['accountId' => (int)$aid, 'inList' => $l, 'withBody' => $w, 'missingBody' => max(0, $l - $w),
					'onlyInAtrium' => $k + $orphanTexts, 'keptRows' => $k, 'keptWithText' => $kt, 'orphanTexts' => $orphanTexts, 'bodiesTotal' => $b];
			}
		}

		// Background jobs from the cron container.
		$jobs = [];
		$qb = $this->db->getQueryBuilder();
		foreach ($qb->select('class', 'argument', 'last_run', 'last_checked', 'reserved_at', 'execution_duration')->from('jobs')
			->where($qb->expr()->like('class', $qb->createNamedParameter('OCA\\\\Mail\\\\BackgroundJob\\\\%')))
			->executeQuery()->fetchAll() as $j) {
			$arg = json_decode((string)$j['argument'], true);
			$accountId = is_array($arg) ? ($arg['accountId'] ?? null) : null;
			if ($accountId !== null && !in_array((int)$accountId, $ids, true)) {
				continue;
			}
			$jobs[] = ['name' => substr(strrchr((string)$j['class'], '\\') ?: (string)$j['class'], 1), 'accountId' => $accountId === null ? null : (int)$accountId,
				'lastRun' => (int)$j['last_run'], 'running' => (int)$j['reserved_at'] > $now - 3600, 'duration' => (int)$j['execution_duration']];
		}
		usort($jobs, static fn ($a, $b) => [$a['name'], $a['accountId']] <=> [$b['name'], $b['accountId']]);

		$state = $this->state();
		$spent = $this->spentToday();
		return [
			'now' => $now,
			'settings' => ['enabled' => $s['enabled'], 'backend' => $s['backend'], 'configured' => $s['configured'], 'capTotalEur' => $s['capTotal'], 'capBackfillEur' => $s['capBackfill'],
				'model' => $s['backend'] === 'ai' ? (string)($state['lastModel'] ?? 'Settings > AI') : $this->questions()['model'], 'questionsVersion' => $this->questions()['version'], 'timezone' => $s['timezone']],
			'state' => [
				'state' => $s['enabled'] ? ($state['state'] ?? 'idle') : 'disabled',
				'pausedUntil' => (int)($state['pausedUntil'] ?? 0) > $now ? (int)$state['pausedUntil'] : null,
				'lastRun' => $state['lastRun'] ?? null, 'lastOk' => $state['lastOk'] ?? null, 'lastScan' => $state['lastScan'] ?? null,
				'lastError' => $state['lastError'] ?? null, 'lastErrorAt' => $state['lastErrorAt'] ?? null,
			],
			'spent' => ['todayEur' => $spent['total'], 'todayBackfillEur' => $spent['backfill'], 'monthEur' => $spentMonth],
			'queue' => ['pendingNew' => $queue['pendingNew'] ?? 0, 'pendingBacklog' => $queue['pendingBacklog'] ?? 0, 'done' => $queue['done'] ?? 0, 'parked' => $queue['parked'] ?? 0],
			'accounts' => array_map(static fn (Account $a) => ['id' => $a->getId(), 'email' => $a->getEmail(), 'name' => $a->getName(),
				'pendingNew' => $perAccount[$a->getId()]['pendingNew'] ?? 0, 'pendingBacklog' => $perAccount[$a->getId()]['pendingBacklog'] ?? 0,
				'done' => $perAccount[$a->getId()]['done'] ?? 0, 'parked' => $perAccount[$a->getId()]['parked'] ?? 0], $accounts),
			'categories' => $categories,
			'flows' => array_values($flowRows),
			'urgency' => $urgency,
			'daily' => array_values($daily),
			'recent' => $recent,
			'problems' => $parked,
			'folders' => $folders,
			'copy' => $copy,
			'jobs' => $jobs,
			'sync' => $this->syncStatus($ids),
		];
	}

	/**
	 * Atrium's DB-first bookkeeping for the status page: writes waiting for the mail server,
	 * reader copies still to fill, attachments kept.
	 *
	 * @param int[] $ids account ids
	 * @return array{pendingWrites: int, failedWrites: int, readerTodo: int, readerUnavailable: int, attachments: int, attachmentBytes: int}
	 */
	private function syncStatus(array $ids): array {
		$ops = new \OCA\Mail\Service\PendingOps($this->db);
		$rb = new \OCA\Mail\Service\ReaderBackfill($this->db);
		$out = ['pendingWrites' => 0, 'failedWrites' => 0, 'readerTodo' => 0, 'readerUnavailable' => 0];
		foreach ($ids as $id) {
			$out['pendingWrites'] += $ops->countPending($id);
			$out['failedWrites'] += $ops->countFailed($id);
			$c = $rb->counts($id);
			$out['readerTodo'] += $c['todo'];
			$out['readerUnavailable'] += $c['unavailable'];
		}
		$att = (new \OCA\Mail\Service\StoredAttachments($this->db))->totals($ids);
		return $out + ['attachments' => $att['count'], 'attachmentBytes' => $att['bytes']];
	}
}
