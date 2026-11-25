<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Atrium;

use OCA\Mail\Db\Tag;
use OCA\Mail\Db\TagMapper;
use OCP\IDBConnection;
use OCP\Server;
use PHPUnit\Framework\TestCase;

/**
 * A tag found on the mail server gets a color (V4-35).
 *
 * mail_tags.color defaults to '#fff' and IMAPMessage::getTags() sets none, so
 * every tag Mail discovered as an IMAP keyword was white: on the live instance
 * 668 of the 676 tagged mails carried a white "Promotion" chip, drawn white on
 * white. The owner could not see which mails were tagged.
 */
class TagColorTest extends TestCase {
	private TagMapper $tags;
	private IDBConnection $db;
	private string $user;

	protected function setUp(): void {
		parent::setUp();
		$this->tags = Server::get(TagMapper::class);
		$this->db = Server::get(IDBConnection::class);
		$this->user = 'atrium-test-' . bin2hex(random_bytes(4));
	}

	protected function tearDown(): void {
		$ids = $this->db->executeQuery('SELECT id FROM *PREFIX*mail_tags WHERE user_id = ?', [$this->user])->fetchAll(\PDO::FETCH_COLUMN);
		foreach ($ids as $id) {
			$this->db->executeStatement('DELETE FROM *PREFIX*mail_message_tags WHERE tag_id = ?', [(int)$id]);
		}
		$this->db->executeStatement('DELETE FROM *PREFIX*mail_tags WHERE user_id = ?', [$this->user]);
		parent::tearDown();
	}

	/** A keyword the server reports, built the way IMAPMessage::getTags() builds it: no color. */
	private function discovered(string $label, string $name): Tag {
		$tag = new Tag();
		$tag->setImapLabel($label);
		$tag->setDisplayName($name);
		$tag->setUserId($this->user);
		return $tag;
	}

	public function testATagDiscoveredOnTheServerIsNotWhite(): void {
		$this->tags->tagMessage($this->discovered('$promotion', 'Promotion'), '<promo@test.invalid>', $this->user);

		$stored = $this->tags->getTagByImapLabel('$promotion', $this->user);
		self::assertFalse(TagMapper::hasNoColor($stored->getColor()), 'a discovered tag must get a color');
		self::assertContains($stored->getColor(), TagMapper::DISCOVERED_COLORS);
	}

	public function testTheSecondMailWithTheSameKeywordReusesTheTag(): void {
		$this->tags->tagMessage($this->discovered('$promotion', 'Promotion'), '<one@test.invalid>', $this->user);
		$first = $this->tags->getTagByImapLabel('$promotion', $this->user)->getColor();
		$this->tags->tagMessage($this->discovered('$promotion', 'Promotion'), '<two@test.invalid>', $this->user);

		$all = $this->tags->getAllTagsForUser($this->user);
		self::assertCount(1, $all);
		self::assertSame($first, $all[0]->getColor());
	}

	public function testAColorSomebodyChoseIsKept(): void {
		$tag = $this->discovered('$mine', 'Mine');
		$tag->setColor('#FF7A66');
		$this->tags->tagMessage($tag, '<mine@test.invalid>', $this->user);

		self::assertSame('#FF7A66', $this->tags->getTagByImapLabel('$mine', $this->user)->getColor());
	}

	public function testWhiteAndNothingMeanNobodyChose(): void {
		foreach (['#fff', '#FFF', '#ffffff', '#FFFFFF', ' #fff ', '#ffff', '#ffffffff', 'white', '', '   ', null] as $color) {
			self::assertTrue(TagMapper::hasNoColor($color), var_export($color, true) . ' means unset');
		}
		foreach (['#FF7A66', '#317CCC', '#fffffe', '#0b6aa8'] as $color) {
			self::assertFalse(TagMapper::hasNoColor($color), "$color is a choice");
		}
	}

	/**
	 * The same numbers as colorIndex() in apps/mail/web/Tags.tsx (asserted there
	 * too): a keyword gets one color, whichever side created its row.
	 */
	public function testTheIndexMatchesTheWebSide(): void {
		self::assertSame(1, TagMapper::colorIndex('$promotion'));
		self::assertSame(0, TagMapper::colorIndex('forwarded'));
		self::assertSame(5, TagMapper::colorIndex('loadremoteimages'));
		self::assertSame(TagMapper::colorIndex('forwarded'), TagMapper::colorIndex('FORWARDED'));
		self::assertSame('#2e7d32', TagMapper::colorFor('$promotion'));
	}
}
