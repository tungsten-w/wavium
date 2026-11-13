<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Contacts\Service;

use Sabre\VObject\Component\VCard;
use Sabre\VObject\Reader;

/**
 * vCard <-> the simple contact shape agents see (P3-3, ADR 0005): name, emails,
 * phones, organisation, title, note, birthday, addresses (read only). Updates
 * touch only the fields given and keep every other property (photo, X-*,
 * whatever a phone client stored), so DAV clients lose nothing.
 */
class AtriumContactMapper {
	public const FIELDS = ['name', 'given_name', 'family_name', 'emails', 'phones', 'org', 'title', 'note', 'birthday'];
	private const MAX_TEXT = 10000;
	private const MAX_ITEMS = 20;

	public static function parse(string $data): VCard {
		$card = Reader::read($data, Reader::OPTION_FORGIVING);
		if (!$card instanceof VCard) {
			throw new \InvalidArgumentException('Not a vCard');
		}
		return $card;
	}

	/** @return array<string, mixed> */
	public static function toArray(VCard $card): array {
		$n = isset($card->N) ? $card->N->getParts() : [];
		$typed = static function (VCard $card, string $prop): array {
			$out = [];
			foreach ($card->select($prop) as $p) {
				$value = trim((string)$p->getValue());
				if ($value === '') {
					continue;
				}
				$types = [];
				foreach ($p['TYPE'] ?? [] as $t) {
					foreach (explode(',', (string)$t) as $one) {
						$one = strtolower(trim($one));
						if ($one !== '' && $one !== 'pref' && $one !== 'internet' && $one !== 'voice') {
							$types[] = $one;
						}
					}
				}
				if ($prop === 'TEL' && str_starts_with($value, 'tel:')) {
					$value = substr($value, 4);
				}
				$out[] = ['value' => $value, 'type' => $types[0] ?? null];
			}
			return $out;
		};
		$addresses = [];
		foreach ($card->select('ADR') as $adr) {
			$p = $adr->getParts();
			$types = array_values(array_filter(array_map(fn ($t) => strtolower((string)$t), iterator_to_array($adr['TYPE'] ?? []))));
			$a = [
				'type' => $types[0] ?? null,
				'street' => trim(($p[2] ?? '') . ' ' . ($p[1] ?? '')) ?: null,
				'city' => ($p[3] ?? '') ?: null,
				'region' => ($p[4] ?? '') ?: null,
				'postcode' => ($p[5] ?? '') ?: null,
				'country' => ($p[6] ?? '') ?: null,
			];
			if (array_filter($a, fn ($v, $k) => $k !== 'type' && $v !== null, ARRAY_FILTER_USE_BOTH)) {
				$addresses[] = $a;
			}
		}
		$org = isset($card->ORG) ? (method_exists($card->ORG, 'getParts') ? ($card->ORG->getParts()[0] ?? '') : (string)$card->ORG) : '';
		return [
			'name' => isset($card->FN) ? (string)$card->FN : trim(($n[1] ?? '') . ' ' . ($n[0] ?? '')),
			'given_name' => ($n[1] ?? '') ?: null,
			'family_name' => ($n[0] ?? '') ?: null,
			'emails' => $typed($card, 'EMAIL'),
			'phones' => $typed($card, 'TEL'),
			'org' => $org !== '' ? $org : null,
			'title' => isset($card->TITLE) ? (string)$card->TITLE : null,
			'note' => isset($card->NOTE) ? (string)$card->NOTE : null,
			'birthday' => isset($card->BDAY) ? (string)$card->BDAY : null,
			'addresses' => $addresses,
		];
	}

	/** A new card from simple fields. */
	public static function create(array $fields, string $uid): VCard {
		$card = new VCard(['VERSION' => '3.0', 'UID' => $uid]);
		self::apply($card, $fields, true);
		return $card;
	}

	/**
	 * Applies the given fields; absent keys are left alone, null or [] clears.
	 *
	 * @throws \InvalidArgumentException on bad input
	 */
	public static function apply(VCard $card, array $f, bool $new = false): void {
		foreach (array_keys($f) as $k) {
			if (!in_array($k, self::FIELDS, true)) {
				throw new \InvalidArgumentException("Unknown field $k");
			}
		}
		$text = static function (mixed $v, string $name): ?string {
			if ($v === null) {
				return null;
			}
			if (!is_string($v)) {
				throw new \InvalidArgumentException("$name must be a string");
			}
			$v = trim(str_replace(["\r\n", "\r"], "\n", $v));
			if (mb_strlen($v) > self::MAX_TEXT) {
				throw new \InvalidArgumentException("$name is too long");
			}
			return $v === '' ? null : $v;
		};
		$single = static function (VCard $card, string $prop, ?string $value): void {
			unset($card->$prop);
			if ($value !== null) {
				$card->add($prop, $value);
			}
		};

		$nameKeys = array_intersect(['name', 'given_name', 'family_name'], array_keys($f));
		if ($nameKeys || $new) {
			$old = isset($card->N) ? $card->N->getParts() : [];
			$given = array_key_exists('given_name', $f) ? $text($f['given_name'], 'given_name') : (($old[1] ?? '') ?: null);
			$family = array_key_exists('family_name', $f) ? $text($f['family_name'], 'family_name') : (($old[0] ?? '') ?: null);
			$fn = array_key_exists('name', $f) ? $text($f['name'], 'name') : null;
			if ($fn === null && (array_key_exists('given_name', $f) || array_key_exists('family_name', $f) || !isset($card->FN))) {
				$fn = trim(($given ?? '') . ' ' . ($family ?? '')) ?: null;
			}
			if ($fn === null && isset($card->FN) && !array_key_exists('name', $f)) {
				$fn = (string)$card->FN;
			}
			if ($fn === null) {
				// FN is required by vCard: fall back on an email or phone.
				$first = fn (string $k) => is_array($f[$k] ?? null) && $f[$k] ? (is_array($f[$k][0]) ? ($f[$k][0]['value'] ?? '') : $f[$k][0]) : '';
				$fn = $first('emails') ?: $first('phones') ?: (isset($card->EMAIL) ? (string)$card->EMAIL : '');
				if ($fn === '') {
					throw new \InvalidArgumentException('A contact needs a name, an email or a phone');
				}
			}
			if ($given === null && $family === null && array_key_exists('name', $f) && !isset($card->N)) {
				// Split "Jane Doe" for N when only the full name is given.
				$parts = preg_split('/\s+/', $fn) ?: [$fn];
				$family = count($parts) > 1 ? array_pop($parts) : null;
				$given = implode(' ', $parts);
			}
			$single($card, 'FN', $fn);
			unset($card->N);
			$card->add('N', [$family ?? '', $given ?? '', '', '', '']);
		}

		foreach (['emails' => 'EMAIL', 'phones' => 'TEL'] as $key => $prop) {
			if (!array_key_exists($key, $f)) {
				continue;
			}
			$list = $f[$key] ?? [];
			if (!is_array($list) || count($list) > self::MAX_ITEMS) {
				throw new \InvalidArgumentException("$key must be a list of at most " . self::MAX_ITEMS);
			}
			unset($card->$prop);
			foreach ($list as $item) {
				$value = is_array($item) ? ($item['value'] ?? null) : $item;
				$type = is_array($item) ? ($item['type'] ?? null) : null;
				$value = $text($value, $key);
				if ($value === null) {
					continue;
				}
				if ($prop === 'EMAIL' && !filter_var($value, FILTER_VALIDATE_EMAIL)) {
					throw new \InvalidArgumentException("Not an email address: $value");
				}
				if ($prop === 'TEL' && !preg_match('/^[+\d][\d\s().\-\/]{1,40}$/', $value)) {
					throw new \InvalidArgumentException("Not a phone number: $value");
				}
				$params = [];
				$type = $text($type, "$key.type");
				if ($type !== null) {
					if (!preg_match('/^[a-z-]{1,20}$/i', $type)) {
						throw new \InvalidArgumentException("Bad $key type: $type");
					}
					$params['TYPE'] = strtoupper($type);
				}
				$card->add($prop, $value, $params);
			}
		}

		foreach (['org' => 'ORG', 'title' => 'TITLE', 'note' => 'NOTE'] as $key => $prop) {
			if (array_key_exists($key, $f)) {
				$single($card, $prop, $text($f[$key], $key));
			}
		}
		if (array_key_exists('birthday', $f)) {
			$b = $text($f['birthday'], 'birthday');
			if ($b !== null && !preg_match('/^(\d{4}|--)-?\d{2}-?\d{2}$/', $b)) {
				throw new \InvalidArgumentException('birthday must be YYYY-MM-DD (or --MM-DD without a year)');
			}
			$single($card, 'BDAY', $b);
		}
		$single($card, 'REV', gmdate('Ymd\THis\Z'));
	}
}
