<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Controller;

use OC\Agent\InternalAuth;
use OCA\Mail\Contracts\IMailManager;
use OCA\Mail\Db\LocalMessage;
use OCA\Mail\Db\Message;
use OCA\Mail\IMAP\IMAPClientFactory;
use OCA\Mail\Service\AccountService;
use OCA\Mail\Service\Attachment\AttachmentService;
use OCA\Mail\Service\DraftsService;
use OCA\Mail\Service\OutboxService;
use OCA\Mail\Service\Triage\TriageService;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\DataDownloadResponse;
use OCP\AppFramework\Http\JSONResponse;
use OCP\AppFramework\Http\Response;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\IRequest;
use Psr\Log\LoggerInterface;

/**
 * Atrium agent layer (ADR 0009): the mail operations that live in PHP, called
 * only by the Bun server (server/agent/mail/write.ts) with X-Atrium-Internal.
 * Bun has already checked the agent's grant; `uid` is the grantor whose mail
 * this is. Every write goes through the same services as the Mail UI.
 */
class AtriumAgentController extends Controller {
	public function __construct(
		string $appName,
		IRequest $request,
		private AccountService $accountService,
		private IMailManager $mailManager,
		private IMAPClientFactory $clientFactory,
		private TriageService $triage,
		private DraftsService $drafts,
		private OutboxService $outbox,
		private AttachmentService $attachments,
		private ITimeFactory $time,
		private LoggerInterface $logger,
	) {
		parent::__construct($appName, $request);
	}

	private function internal(): bool {
		return \OCP\Server::get(InternalAuth::class)->isInternal($this->request);
	}

	private static function error(int $status, string $message, ?string $reason = null): JSONResponse {
		return new JSONResponse(['message' => $message] + ($reason !== null ? ['reason' => $reason] : []), $status);
	}

	/**
	 * @return array{0: \OCA\Mail\Account, 1: \OCA\Mail\Db\Mailbox, 2: Message}
	 */
	private function load(string $uid, int $id): array {
		$message = $this->mailManager->getMessage($uid, $id);
		$mailbox = $this->mailManager->getMailbox($uid, $message->getMailboxId());
		$account = $this->accountService->find($uid, $mailbox->getAccountId());
		return [$account, $mailbox, $message];
	}

	private function guard(callable $fn): Response {
		if (!$this->internal()) {
			return self::error(Http::STATUS_FORBIDDEN, 'internal only');
		}
		try {
			return $fn();
		} catch (DoesNotExistException $e) {
			return self::error(Http::STATUS_NOT_FOUND, $e->getMessage() !== '' ? $e->getMessage() : 'Not found');
		} catch (\OCA\Mail\Exception\ClientException|\InvalidArgumentException $e) {
			return self::error(Http::STATUS_BAD_REQUEST, $e->getMessage());
		} catch (\Throwable $e) {
			$this->logger->warning('Atrium agent mail call failed: ' . $e->getMessage(), ['exception' => $e]);
			return self::error(Http::STATUS_SERVICE_UNAVAILABLE, $e->getMessage());
		}
	}

	/** Fetch a mail from the server once and keep Atrium's copy (mail_bodies). */
	#[PublicPage]
	#[NoCSRFRequired]
	public function body(string $uid, int $id): Response {
		return $this->guard(function () use ($uid, $id) {
			[$account, $mailbox, $message] = $this->load($uid, $id);
			if ($message->isGoneFromServer()) {
				return self::error(Http::STATUS_CONFLICT, 'The mail is no longer on the mail server', 'gone');
			}
			$client = $this->clientFactory->getClient($account);
			try {
				$imap = $this->mailManager->getImapMessage($client, $account, $mailbox, $message->getUid(), true);
				$json = $imap->getFullMessage($id);
			} finally {
				$client->logout();
			}
			$this->triage->storeBody($account, $mailbox, $imap, TriageService::hash($message->getMessageId(), $id), $json);
			return new JSONResponse(['stored' => true]);
		});
	}

	/** @param array<string, bool> $flags seen, flagged */
	#[PublicPage]
	#[NoCSRFRequired]
	public function flags(string $uid, int $id, array $flags): Response {
		return $this->guard(function () use ($uid, $id, $flags) {
			[$account, $mailbox, $message] = $this->load($uid, $id);
			foreach ($flags as $flag => $value) {
				if (!in_array($flag, ['seen', 'flagged'], true)) {
					return self::error(Http::STATUS_BAD_REQUEST, "Unknown flag $flag");
				}
				$this->mailManager->flagMessage($account, $mailbox->getName(), $message->getUid(), $flag, (bool)$value);
			}
			return new JSONResponse(['ok' => true]);
		});
	}

	#[PublicPage]
	#[NoCSRFRequired]
	public function move(string $uid, int $id, int $dest): Response {
		return $this->guard(function () use ($uid, $id, $dest) {
			[$account, $mailbox, $message] = $this->load($uid, $id);
			$target = $this->mailManager->getMailbox($uid, $dest);
			$targetAccount = $this->accountService->find($uid, $target->getAccountId());
			if ($target->getId() === $mailbox->getId()) {
				return new JSONResponse(['ok' => true, 'moved' => false]);
			}
			$this->mailManager->moveMessage($account, $mailbox->getName(), $message->getUid(), $targetAccount, $target->getName());
			return new JSONResponse(['ok' => true, 'moved' => true]);
		});
	}

	/** Move to Trash, as the Mail UI's delete does (never a hard delete). */
	#[PublicPage]
	#[NoCSRFRequired]
	public function trash(string $uid, int $id): Response {
		return $this->guard(function () use ($uid, $id) {
			[$account, $mailbox, $message] = $this->load($uid, $id);
			$trashId = $account->getMailAccount()->getTrashMailboxId();
			if ($trashId === null) {
				return self::error(Http::STATUS_CONFLICT, 'This account has no Trash folder', 'no_trash');
			}
			if ($mailbox->getId() === $trashId) {
				return new JSONResponse(['ok' => true, 'moved' => false]);
			}
			$trash = $this->mailManager->getMailbox($uid, $trashId);
			$this->mailManager->moveMessage($account, $mailbox->getName(), $message->getUid(), $account, $trash->getName());
			return new JSONResponse(['ok' => true, 'moved' => true]);
		});
	}

	/** Attachment content (stored on first download, as for the UI). */
	#[PublicPage]
	#[NoCSRFRequired]
	public function attachment(string $uid, int $id, string $part): Response {
		return $this->guard(function () use ($uid, $id, $part) {
			[$account, $mailbox, $message] = $this->load($uid, $id);
			$attachment = $this->mailManager->getMailAttachment($account, $mailbox, $message, $part);
			return new DataDownloadResponse($attachment->getContent(), $attachment->getName() ?? "part-$part.eml", $attachment->getType());
		});
	}

	/**
	 * Create or update a draft (LocalMessage). Attachments:
	 * {type: local, id} keeps one, {type: file, filename, mime, base64} adds one,
	 * {type: message-attachment, messageId, part} copies one from a mail,
	 * {type: message, messageId} attaches a whole mail (.eml).
	 *
	 * @param list<array{label?: string, email: string}> $to
	 * @param list<array{label?: string, email: string}> $cc
	 * @param list<array{label?: string, email: string}> $bcc
	 * @param list<array<string, mixed>> $attachments
	 */
	#[PublicPage]
	#[NoCSRFRequired]
	public function draft(string $uid, int $accountId, string $subject, string $body, array $to = [], array $cc = [], array $bcc = [], array $attachments = [], ?int $draftId = null, ?string $inReplyTo = null): Response {
		return $this->guard(function () use ($uid, $accountId, $subject, $body, $to, $cc, $bcc, $attachments, $draftId, $inReplyTo) {
			$account = $this->accountService->find($uid, $accountId);
			$resolved = [];
			foreach ($attachments as $a) {
				$type = (string)($a['type'] ?? '');
				if ($type === 'local') {
					$resolved[] = ['type' => 'local', 'id' => (int)$a['id']];
				} elseif ($type === 'file') {
					$content = base64_decode((string)($a['base64'] ?? ''), true);
					if ($content === false) {
						return self::error(Http::STATUS_BAD_REQUEST, 'Attachment content is not valid base64');
					}
					$local = $this->attachments->addFileFromString($uid, (string)$a['filename'], (string)($a['mime'] ?? 'application/octet-stream'), $content, null, 'attachment');
					$resolved[] = ['type' => 'local', 'id' => $local->getId()];
				} elseif ($type === 'message-attachment') {
					[, $mb, $msg] = $this->load($uid, (int)$a['messageId']);
					$resolved[] = ['type' => 'message-attachment', 'mailboxId' => $mb->getId(), 'uid' => $msg->getUid(), 'id' => (string)$a['part'], 'fileName' => $a['fileName'] ?? null];
				} elseif ($type === 'message') {
					$this->load($uid, (int)$a['messageId']);
					$resolved[] = ['type' => 'message', 'id' => (int)$a['messageId']];
				} else {
					return self::error(Http::STATUS_BAD_REQUEST, "Unknown attachment type $type");
				}
			}
			$norm = static fn (array $list): array => array_map(static fn ($r) => ['label' => (string)($r['label'] ?? ''), 'email' => (string)$r['email']], $list);
			if ($draftId === null) {
				$message = new LocalMessage();
			} else {
				$message = $this->drafts->getMessage($draftId, $uid);
				if ($message->getType() !== LocalMessage::TYPE_DRAFT) {
					return self::error(Http::STATUS_CONFLICT, 'Not a draft any more', 'not_draft');
				}
			}
			$message->setType(LocalMessage::TYPE_DRAFT);
			$message->setAccountId($accountId);
			$message->setSubject($subject);
			$message->setBodyPlain($body);
			$message->setBodyHtml(null);
			$message->setHtml(false);
			$message->setEditorBody($body);
			$message->setInReplyToMessageId($inReplyTo);
			$message->setUpdatedAt($this->time->getTime());
			$message->setSendAt(null);
			$message->setAiGenerated(true);
			$message = $draftId === null
				? $this->drafts->saveMessage($account, $message, $norm($to), $norm($cc), $norm($bcc), $resolved)
				: $this->drafts->updateMessage($account, $message, $norm($to), $norm($cc), $norm($bcc), $resolved);
			return new JSONResponse(['id' => $message->getId()]);
		});
	}

	/** Send a draft now: the normal outbox path (convert, then send). */
	#[PublicPage]
	#[NoCSRFRequired]
	public function send(string $uid, int $draftId): Response {
		return $this->guard(function () use ($uid, $draftId) {
			$draft = $this->drafts->getMessage($draftId, $uid);
			if ($draft->getType() !== LocalMessage::TYPE_DRAFT) {
				return self::error(Http::STATUS_CONFLICT, 'Not a draft any more', 'not_draft');
			}
			$account = $this->accountService->find($uid, $draft->getAccountId());
			$outgoing = $this->outbox->convertDraft($draft, $this->time->getTime());
			$sent = $this->outbox->sendMessage($outgoing, $account);
			if ($sent->getStatus() !== LocalMessage::STATUS_PROCESSED) {
				$why = match ($sent->getStatus()) {
					LocalMessage::STATUS_NO_SENT_MAILBOX => 'the account has no Sent folder',
					LocalMessage::STATUS_TOO_MANY_RECIPIENTS => 'too many recipients',
					LocalMessage::STATUS_RATELIMIT => 'the sending rate limit was reached',
					LocalMessage::STATUS_SMPT_SEND_FAIL => 'the SMTP server refused or could not be reached',
					LocalMessage::STATUS_IMAP_SENT_MAILBOX_FAIL => 'it was sent but could not be copied to the Sent folder',
					default => 'status ' . $sent->getStatus(),
				};
				return self::error(Http::STATUS_SERVICE_UNAVAILABLE, "Sending failed: $why. The message stays in the outbox, where Mail retries it.", 'send_failed');
			}
			return new JSONResponse(['sent' => true, 'id' => $sent->getId()]);
		});
	}
}
