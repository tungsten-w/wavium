<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Contacts\Controller;

use OC\Agent\InternalAuth;
use OCA\Contacts\Service\AtriumContactMapper;
use OCA\DAV\CardDAV\CardDavBackend;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\JSONResponse;
use OCP\IRequest;
use OCP\IUserManager;
use Psr\Log\LoggerInterface;

/**
 * Contacts for the agent layer (P3-3). Called only by the Bun server
 * (server/agent/contacts/) with X-Atrium-Internal; every call acts as `uid`
 * (the grantor). Writes go through CardDavBackend, so sync tokens and change
 * logs move and phone/desktop DAV clients see the change (ADR 0008). Agents
 * get simple fields, never the raw vCard (AtriumContactMapper).
 */
class AtriumAgentController extends Controller {
	private const RO = '{http://owncloud.org/ns}read-only';
	private const OWNER = '{http://owncloud.org/ns}owner-principal';
	private const MAX_LIST = 200;

	public function __construct(
		string $appName,
		IRequest $request,
		private CardDavBackend $backend,
		private IUserManager $users,
		private LoggerInterface $logger,
	) {
		parent::__construct($appName, $request);
	}

	private static function error(int $status, string $message): JSONResponse {
		return new JSONResponse(['message' => $message], $status);
	}

	private function guard(string $uid, callable $fn): JSONResponse {
		if (!\OCP\Server::get(InternalAuth::class)->isInternal($this->request)) {
			return self::error(Http::STATUS_FORBIDDEN, 'internal only');
		}
		if ($uid === '' || $this->users->get($uid) === null) {
			return self::error(Http::STATUS_NOT_FOUND, 'No such user');
		}
		try {
			return $fn();
		} catch (\InvalidArgumentException $e) {
			return self::error(Http::STATUS_BAD_REQUEST, $e->getMessage());
		} catch (\Sabre\DAV\Exception\NotFound $e) {
			return self::error(Http::STATUS_NOT_FOUND, $e->getMessage() ?: 'Not found');
		} catch (\Throwable $e) {
			$this->logger->warning('Atrium agent contacts call failed: ' . $e->getMessage(), ['exception' => $e]);
			return self::error(Http::STATUS_SERVICE_UNAVAILABLE, 'Contacts are unavailable');
		}
	}

	/** @return array<int, array{id: int, name: string, read_only: bool, shared_by: ?string}> */
	private function books(string $uid): array {
		$out = [];
		foreach ($this->backend->getAddressBooksForUser('principals/users/' . $uid) as $b) {
			$owner = $b[self::OWNER] ?? $b['principaluri'] ?? '';
			$ownerUid = str_starts_with((string)$owner, 'principals/users/') ? substr((string)$owner, 17) : null;
			$out[(int)$b['id']] = [
				'id' => (int)$b['id'],
				'name' => (string)($b['{DAV:}displayname'] ?? $b['uri']),
				'read_only' => (bool)($b[self::RO] ?? false),
				'shared_by' => $ownerUid !== null && $ownerUid !== $uid ? $ownerUid : null,
			];
		}
		return $out;
	}

	private function book(string $uid, int $id, bool $write): array {
		$books = $this->books($uid);
		if (!isset($books[$id])) {
			throw new \Sabre\DAV\Exception\NotFound("No address book $id");
		}
		if ($write && $books[$id]['read_only']) {
			throw new \InvalidArgumentException("Address book \"{$books[$id]['name']}\" is shared read-only");
		}
		return $books[$id];
	}

	private function row(array $card, int $book): array {
		$c = AtriumContactMapper::toArray(AtriumContactMapper::parse((string)$card['carddata']));
		return ['addressbook' => $book, 'card' => (string)$card['uri'], 'etag' => trim((string)$card['etag'], '"'), 'updated' => (int)$card['lastmodified']] + $c;
	}

	#[PublicPage]
	#[NoCSRFRequired]
	public function addressbooks(string $uid = ''): JSONResponse {
		return $this->guard($uid, fn () => new JSONResponse(['addressbooks' => array_values($this->books($uid))]));
	}

	/** Every contact of the user's books (or one book), filtered by `query` over name, emails, phones, org. */
	#[PublicPage]
	#[NoCSRFRequired]
	public function list(string $uid = '', ?int $addressbook = null, string $query = '', int $limit = 50, int $offset = 0): JSONResponse {
		return $this->guard($uid, function () use ($uid, $addressbook, $query, $limit, $offset) {
			$books = $addressbook !== null ? [$this->book($uid, $addressbook, false)] : array_values($this->books($uid));
			$q = mb_strtolower(trim($query));
			$digits = preg_replace('/\D/', '', $q);
			$rows = [];
			foreach ($books as $b) {
				foreach ($this->backend->getCards($b['id']) as $card) {
					try {
						$r = $this->row($card, $b['id']);
					} catch (\Throwable) {
						continue; // a broken card from some client: skip, do not fail the list
					}
					if ($q !== '') {
						$hay = mb_strtolower(implode(' ', [$r['name'], $r['org'] ?? '', ...array_column($r['emails'], 'value')]));
						$phoneHit = $digits !== '' && strlen($digits) >= 3
							&& array_filter($r['phones'], fn ($p) => str_contains(preg_replace('/\D/', '', $p['value']), $digits));
						if (!str_contains($hay, $q) && !$phoneHit) {
							continue;
						}
					}
					$rows[] = $r;
				}
			}
			usort($rows, fn ($a, $b) => strcasecmp($a['name'], $b['name']) ?: strcmp($a['card'], $b['card']));
			$limit = max(1, min(self::MAX_LIST, $limit));
			$offset = max(0, $offset);
			return new JSONResponse(['contacts' => array_slice($rows, $offset, $limit), 'total' => count($rows)]);
		});
	}

	#[PublicPage]
	#[NoCSRFRequired]
	public function get(string $uid = '', int $addressbook = 0, string $card = ''): JSONResponse {
		return $this->guard($uid, function () use ($uid, $addressbook, $card) {
			$this->book($uid, $addressbook, false);
			$row = $this->backend->getCard($addressbook, $card);
			if (!$row) {
				throw new \Sabre\DAV\Exception\NotFound('No such contact');
			}
			return new JSONResponse($this->row($row, $addressbook));
		});
	}

	/** New contact; `addressbook` defaults to the user's first own writable book. */
	#[PublicPage]
	#[NoCSRFRequired]
	public function create(string $uid = '', ?int $addressbook = null, array $contact = []): JSONResponse {
		return $this->guard($uid, function () use ($uid, $addressbook, $contact) {
			if ($addressbook === null) {
				$own = array_values(array_filter($this->books($uid), fn ($b) => !$b['read_only'] && $b['shared_by'] === null));
				if (!$own) {
					throw new \InvalidArgumentException('No address book to write to');
				}
				$addressbook = $own[0]['id'];
			}
			$this->book($uid, $addressbook, true);
			$vuid = \OCP\Server::get(\OCP\Security\ISecureRandom::class)->generate(32, \OCP\Security\ISecureRandom::CHAR_LOWER . \OCP\Security\ISecureRandom::CHAR_DIGITS);
			$card = AtriumContactMapper::create($contact, $vuid);
			$uri = $vuid . '.vcf';
			$this->backend->createCard($addressbook, $uri, $card->serialize());
			return new JSONResponse($this->row($this->backend->getCard($addressbook, $uri), $addressbook));
		});
	}

	/** Changes the given fields only; `etag` (optional) refuses the write if the card changed meanwhile. */
	#[PublicPage]
	#[NoCSRFRequired]
	public function update(string $uid = '', int $addressbook = 0, string $card = '', array $contact = [], ?string $etag = null): JSONResponse {
		return $this->guard($uid, function () use ($uid, $addressbook, $card, $contact, $etag) {
			$this->book($uid, $addressbook, true);
			$row = $this->backend->getCard($addressbook, $card);
			if (!$row) {
				throw new \Sabre\DAV\Exception\NotFound('No such contact');
			}
			if ($etag !== null && $etag !== '' && trim((string)$row['etag'], '"') !== $etag) {
				return self::error(Http::STATUS_CONFLICT, 'The contact changed since it was read');
			}
			$v = AtriumContactMapper::parse((string)$row['carddata']);
			AtriumContactMapper::apply($v, $contact);
			$this->backend->updateCard($addressbook, $card, $v->serialize());
			return new JSONResponse($this->row($this->backend->getCard($addressbook, $card), $addressbook));
		});
	}

	/** Deletes and returns the vCard, so the agent layer can keep a copy to restore. */
	#[PublicPage]
	#[NoCSRFRequired]
	public function delete(string $uid = '', int $addressbook = 0, string $card = ''): JSONResponse {
		return $this->guard($uid, function () use ($uid, $addressbook, $card) {
			$this->book($uid, $addressbook, true);
			$row = $this->backend->getCard($addressbook, $card);
			if (!$row) {
				throw new \Sabre\DAV\Exception\NotFound('No such contact');
			}
			$this->backend->deleteCard($addressbook, $card);
			return new JSONResponse(['deleted' => true, 'carddata' => (string)$row['carddata']]);
		});
	}

	/** Puts a deleted card back (same UID and URI). */
	#[PublicPage]
	#[NoCSRFRequired]
	public function restore(string $uid = '', int $addressbook = 0, string $card = '', string $carddata = ''): JSONResponse {
		return $this->guard($uid, function () use ($uid, $addressbook, $card, $carddata) {
			$this->book($uid, $addressbook, true);
			AtriumContactMapper::parse($carddata);
			if ($this->backend->getCard($addressbook, $card)) {
				return self::error(Http::STATUS_CONFLICT, 'A contact with this id exists again');
			}
			$this->backend->createCard($addressbook, $card, $carddata);
			return new JSONResponse($this->row($this->backend->getCard($addressbook, $card), $addressbook));
		});
	}
}
