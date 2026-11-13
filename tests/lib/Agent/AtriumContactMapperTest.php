<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace Test\Agent;

use OCA\Contacts\Service\AtriumContactMapper;
use Test\TestCase;

/** P3-3: vCard <-> simple contact fields, keeping what clients stored. */
class AtriumContactMapperTest extends TestCase {
	private const PHONE_CARD = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:abc-1\r\nFN:Anne Martin\r\nN:Martin;Anne;;;\r\n"
		. "EMAIL;TYPE=INTERNET,WORK:anne@example.org\r\nEMAIL;TYPE=HOME:anne.m@example.net\r\nTEL;TYPE=CELL,VOICE:+33 6 12 34 56 78\r\n"
		. "ORG:Acme;R&D\r\nTITLE:Engineer\r\nBDAY:1990-04-02\r\nADR;TYPE=HOME:;;1 rue de la Paix;Paris;;75002;France\r\n"
		. "PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRg==\r\nX-SOCIALPROFILE;TYPE=mastodon:https://social.example/@anne\r\nEND:VCARD\r\n";

	public function testReadsSimpleFields(): void {
		$c = AtriumContactMapper::toArray(AtriumContactMapper::parse(self::PHONE_CARD));
		$this->assertSame('Anne Martin', $c['name']);
		$this->assertSame('Anne', $c['given_name']);
		$this->assertSame('Martin', $c['family_name']);
		$this->assertSame([['value' => 'anne@example.org', 'type' => 'work'], ['value' => 'anne.m@example.net', 'type' => 'home']], $c['emails']);
		$this->assertSame([['value' => '+33 6 12 34 56 78', 'type' => 'cell']], $c['phones']);
		$this->assertSame('Acme', $c['org']);
		$this->assertSame('Engineer', $c['title']);
		$this->assertSame('1990-04-02', $c['birthday']);
		$this->assertSame([['type' => 'home', 'street' => '1 rue de la Paix', 'city' => 'Paris', 'region' => null, 'postcode' => '75002', 'country' => 'France']], $c['addresses']);
		$this->assertArrayNotHasKey('photo', $c);
	}

	public function testUpdateKeepsOtherProperties(): void {
		$card = AtriumContactMapper::parse(self::PHONE_CARD);
		AtriumContactMapper::apply($card, ['title' => 'CTO', 'phones' => [['value' => '+33 1 23 45 67 89', 'type' => 'work']]]);
		$out = $card->serialize();
		$this->assertStringContainsString('TITLE:CTO', $out);
		$this->assertStringContainsString('PHOTO', $out);
		$this->assertStringContainsString('X-SOCIALPROFILE', $out);
		$this->assertStringContainsString('ADR', $out);
		$this->assertStringContainsString('anne.m@example.net', $out); // emails untouched
		$this->assertStringNotContainsString('12 34 56 78', $out); // phones replaced
		$this->assertStringContainsString('UID:abc-1', $out);
		$this->assertStringContainsString('REV:', $out);
		$c = AtriumContactMapper::toArray($card);
		$this->assertSame('Anne Martin', $c['name']); // name untouched
		$this->assertSame([['value' => '+33 1 23 45 67 89', 'type' => 'work']], $c['phones']);
	}

	public function testNullClearsAndNameParts(): void {
		$card = AtriumContactMapper::parse(self::PHONE_CARD);
		AtriumContactMapper::apply($card, ['title' => null, 'birthday' => null, 'family_name' => 'Durand']);
		$c = AtriumContactMapper::toArray($card);
		$this->assertNull($c['title']);
		$this->assertNull($c['birthday']);
		$this->assertSame('Anne Durand', $c['name']); // FN follows the new parts
		$this->assertSame('Durand', $c['family_name']);
	}

	public function testCreate(): void {
		$card = AtriumContactMapper::create(['name' => 'Jean Paul Dupont', 'emails' => ['jp@example.org'], 'phones' => [['value' => '06 11 22 33 44', 'type' => 'cell']]], 'u1');
		$out = $card->serialize();
		$this->assertStringContainsString('VERSION:3.0', $out);
		$this->assertStringContainsString('UID:u1', $out);
		$this->assertSame([], $card->validate());
		$c = AtriumContactMapper::toArray($card);
		$this->assertSame('Jean Paul Dupont', $c['name']);
		$this->assertSame('Jean Paul', $c['given_name']);
		$this->assertSame('Dupont', $c['family_name']);
		$this->assertSame([['value' => 'jp@example.org', 'type' => null]], $c['emails']);

		// An email alone is enough: it becomes the shown name.
		$c2 = AtriumContactMapper::toArray(AtriumContactMapper::create(['emails' => [['value' => 'x@example.org']]], 'u2'));
		$this->assertSame('x@example.org', $c2['name']);
	}

	public static function badInput(): array {
		return [
			'nothing' => [[]],
			'unknown field' => [['name' => 'A', 'photo' => 'x']],
			'bad email' => [['name' => 'A', 'emails' => ['not an email']]],
			'bad phone' => [['name' => 'A', 'phones' => ['call me']]],
			'bad type' => [['name' => 'A', 'emails' => [['value' => 'a@b.org', 'type' => 'x;y']]]],
			'bad birthday' => [['name' => 'A', 'birthday' => 'April 2nd']],
			'not a string' => [['name' => ['A']]],
			'too many' => [['name' => 'A', 'emails' => array_fill(0, 21, 'a@b.org')]],
		];
	}

	#[\PHPUnit\Framework\Attributes\DataProvider('badInput')]
	public function testRefusesBadInput(array $fields): void {
		$this->expectException(\InvalidArgumentException::class);
		AtriumContactMapper::create($fields, 'u3');
	}

	public function testInjectionStaysInOneProperty(): void {
		$card = AtriumContactMapper::create(['name' => "Eve\r\nEMAIL:evil@example.org", 'note' => "line1\nline2"], 'u4');
		$c = AtriumContactMapper::toArray(AtriumContactMapper::parse($card->serialize()));
		$this->assertSame([], $c['emails']);
		$this->assertSame("line1\nline2", $c['note']);
	}
}
