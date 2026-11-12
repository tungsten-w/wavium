<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Atrium: mail that leaves the mail server stays in Atrium (dev stack only).
 * Runs against the dev greenmail account test1@atrium.test (account id 1):
 *   docker exec -u 1000 atrium-dev-php-1 php apps/mail/tests/atrium/kept-mail-test.php
 * It sends its own mails (Message-IDs <kept-*@atrium.test>) and leaves them.
 */

require __DIR__ . '/../../../../lib/base.php';

use OCA\Mail\Db\MailboxMapper;
use OCA\Mail\Db\MessageMapper;
use OCA\Mail\IMAP\IMAPClientFactory;
use OCA\Mail\IMAP\MailboxSync;
use OCA\Mail\Service\AccountService;
use OCA\Mail\Service\MailManager;
use OCA\Mail\Service\Sync\ImapToDbSynchronizer;
use OCP\IDBConnection;
use OCP\Server;
use Psr\Log\NullLogger;

$accountId = (int)($argv[1] ?? 1);
$fails = 0;
function check(bool $ok, string $what): void {
	global $fails;
	echo ($ok ? '  ok   ' : '  FAIL ') . $what . "\n";
	$fails += $ok ? 0 : 1;
}

$db = Server::get(IDBConnection::class);
$account = Server::get(AccountService::class)->findById($accountId);
$boxes = Server::get(MailboxMapper::class);
$sync = Server::get(ImapToDbSynchronizer::class);
$mailboxSync = Server::get(MailboxSync::class);
$manager = Server::get(MailManager::class);
$mapper = Server::get(MessageMapper::class);
$imap = Server::get(IMAPClientFactory::class)->getClient($account, false);
$log = new NullLogger();
$run = bin2hex(random_bytes(3));

$rows = static function (string $msgId) use ($db, $accountId): array {
	return $db->executeQuery('SELECT m.id, m.uid, m.mailbox_id, m.server_gone_at, m.flag_seen, mb.name FROM *PREFIX*mail_messages m JOIN *PREFIX*mail_mailboxes mb ON mb.id = m.mailbox_id WHERE mb.account_id = ? AND m.message_id = ?', [$accountId, $msgId])->fetchAll();
};
$syncAll = static function () use ($mailboxSync, $sync, $account, $log, $boxes): void {
	$mailboxSync->sync($account, $log, true);
	$c = Server::get(IMAPClientFactory::class)->getClient($account);
	foreach ($boxes->findAll($account) as $mb) {
		if ($mb->getSelectable() !== false) {
			$sync->sync($account, $c, $mb, $log);
		}
	}
	$c->logout();
};
$mail = static function (string $box, string $msgId, string $subject) use ($imap): void {
	$d = date('r');
	$imap->append($box, [['data' => "From: Kept Test <test2@atrium.test>\r\nTo: test1@atrium.test\r\nSubject: $subject\r\nDate: $d\r\nMessage-ID: $msgId\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=K\r\n\r\n--K\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBody of $subject.\r\n--K--\r\n"]]);
};
$uidOf = static function (string $box, string $msgId) use ($imap): int {
	$q = new Horde_Imap_Client_Search_Query();
	$q->headerText('Message-ID', $msgId);
	$ids = $imap->search($box, $q, ['results' => [Horde_Imap_Client::SEARCH_RESULTS_MATCH]])['match']->ids;
	return (int)($ids[0] ?? 0);
};
$expunge = static function (string $box, int $uid) use ($imap): void {
	$imap->store($box, ['ids' => new Horde_Imap_Client_Ids([$uid]), 'add' => [Horde_Imap_Client::FLAG_DELETED]]);
	$imap->expunge($box, ['ids' => new Horde_Imap_Client_Ids([$uid])]);
};
foreach (['test', 'Trash'] as $f) {
	try { $imap->createMailbox($f); } catch (Throwable) {}
}

$A = "<kept-a-$run@atrium.test>"; // deleted on the server -> kept
$B = "<kept-b-$run@atrium.test>"; // moved on the server -> no ghost
$C = "<kept-c-$run@atrium.test>"; // gone, then back -> one row again
$mail('INBOX', $A, "Kept A $run");
$mail('INBOX', $B, "Kept B $run");
$mail('INBOX', $C, "Kept C $run");
$syncAll();
check(count($rows($A)) === 1 && count($rows($B)) === 1, 'three new mails synced into INBOX');

echo "1. vanished on the server\n";
$expunge('INBOX', $uidOf('INBOX', $A));
$imap->copy('INBOX', 'test', ['ids' => new Horde_Imap_Client_Ids([$uidOf('INBOX', $B)]), 'move' => true]);
$expunge('INBOX', $uidOf('INBOX', $C));
$syncAll();
$a = $rows($A);
check(count($a) === 1 && $a[0]['server_gone_at'] !== null && (int)$a[0]['uid'] === -(int)$a[0]['id'] && $a[0]['name'] === 'INBOX', 'A kept in INBOX, marked gone, uid = -id');
$b = $rows($B);
check(count($b) === 1 && $b[0]['name'] === 'test' && $b[0]['server_gone_at'] === null, 'B moved to test: one row, no ghost in INBOX');
check(count($rows($C)) === 1 && $rows($C)[0]['server_gone_at'] !== null, 'C kept while gone');
$inbox = $boxes->find($account, 'INBOX');
check(!in_array((int)$a[0]['uid'], $mapper->findAllUids($inbox), true), 'kept rows are not sent to the server as known UIDs');

echo "2. sync again does not crash or duplicate\n";
$syncAll();
check(count($rows($A)) === 1 && count($rows($C)) === 1, 'still one row each');

echo "3. the same mail comes back on the server\n";
$mail('INBOX', $C, "Kept C $run");
$syncAll();
$c = $rows($C);
check(count($c) === 1 && $c[0]['server_gone_at'] === null && (int)$c[0]['uid'] > 0, 'C back to a normal server row, kept copy replaced');

echo "4. actions on a kept mail stay in Atrium\n";
$manager->flagMessage($account, 'INBOX', (int)$a[0]['uid'], 'seen', true);
check((bool)$rows($A)[0]['flag_seen'] === true, 'flag (seen) works on the kept row, no IMAP');
$manager->deleteMessage($account, 'INBOX', (int)$a[0]['uid']);
check($rows($A)[0]['name'] === 'Trash', 'delete moves the kept row to Trash in Atrium');
try {
	$manager->deleteMessage($account, 'Trash', (int)$a[0]['uid']);
	check(false, 'delete in Trash refused');
} catch (\OCA\Mail\Exception\ClientException $e) {
	check(count($rows($A)) === 1, 'delete in Trash refused, Atrium keeps its copy: ' . $e->getMessage());
}

echo "5. folder removed from the server: greenmail cannot delete folders, covered by tests/Unit (MailboxSync)\n";

echo "6. cache reset (UID validity change) keeps what is gone and rebuilds the rest\n";
Server::get(\OCA\Mail\Service\Sync\SyncService::class)->clearCache($account, $boxes->find($account, 'test'));
$syncAll();
$b = $rows($B);
check(count($b) === 1 && $b[0]['server_gone_at'] === null, 'B back as a normal row after the reset, no duplicate');

echo "7. Trash purge (permanent delete) keeps our copy\n";
$E = "<kept-e-$run@atrium.test>";
$mail('Trash', $E, "Kept E $run");
$syncAll();
$expunge('Trash', $uidOf('Trash', $E));
$syncAll();
$e = $rows($E);
check(count($e) === 1 && $e[0]['server_gone_at'] !== null && $e[0]['name'] === 'Trash', 'E purged from Trash on the server, kept in Atrium Trash');

$imap->logout();
echo $fails === 0 ? "ALL OK\n" : "$fails FAILED\n";
exit($fails === 0 ? 0 : 1);
