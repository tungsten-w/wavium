<?php

declare(strict_types=1);
// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Demo data for the DEV stack only (deploy/dev/init.sh, first start).
// Two accounts (alice, bob) with mail in the local GreenMail server, calendar
// events, tasks, contacts and a few files. Every address is @atrium.test or
// @example.*: nothing here is real.
//   php deploy/dev/seed.php            (inside the php container)

if (PHP_SAPI !== 'cli') {
	exit(1);
}
$root = dirname(__DIR__, 2);
require_once $root . '/lib/base.php';

const DEMO_USERS = [
	'alice' => ['Alice Martin', 'alice-demo-pass'],
	'bob' => ['Bob Durand', 'bob-demo-pass'],
];
/**
 * An account with nothing in it. The first screens a new person sees (every
 * empty state, "add a mail account", "no AI provider yet") only exist on an
 * account that has no data, so the demo instance keeps one next to alice and
 * bob. It is created like the others but seeded with nothing: the data loops
 * below walk DEMO_USERS only.
 */
const EMPTY_USER = [
	'chloe' => ['Chloé Nouveau', 'chloe-demo-pass'],
];
const MAIL_PASSWORD = 'demo-mail';
const MAIL_HOST = 'greenmail';

function say(string $m): void {
	fwrite(STDOUT, "seed: $m\n");
}

function occ(string ...$args): string {
	global $root;
	$cmd = 'php ' . escapeshellarg("$root/occ") . ' ' . implode(' ', array_map('escapeshellarg', $args)) . ' 2>&1';
	exec($cmd, $out, $code);
	if ($code !== 0) {
		say('occ ' . $args[0] . ' failed: ' . implode(' ', $out));
	}
	return implode("\n", $out);
}

// ---------------------------------------------------------------- users

$users = \OCP\Server::get(\OCP\IUserManager::class);
$config = \OCP\Server::get(\OCP\IConfig::class);
foreach (DEMO_USERS + EMPTY_USER as $uid => [$name, $password]) {
	$user = $users->get($uid) ?? $users->createUser($uid, $password);
	if ($user === false) {
		throw new RuntimeException("cannot create $uid");
	}
	$user->setDisplayName($name);
	$user->setSystemEMailAddress("$uid@atrium.test");
	$config->setUserValue($uid, 'core', 'timezone', 'Europe/Paris');
	say("user $uid");
}

// ---------------------------------------------------------------- mail (GreenMail over IMAP)

final class Imap {
	/** @var resource */
	private $s;
	private int $n = 0;

	public function __construct(string $host, int $port) {
		for ($i = 0; $i < 30; $i++) {
			$s = @stream_socket_client("tcp://$host:$port", $errno, $err, 5);
			if ($s !== false) {
				$this->s = $s;
				fgets($s);
				return;
			}
			sleep(2);
		}
		throw new RuntimeException("IMAP $host:$port not reachable");
	}

	public function cmd(string $line, ?string $literal = null): string {
		$tag = 'a' . (++$this->n);
		if ($literal === null) {
			fwrite($this->s, "$tag $line\r\n");
		} else {
			fwrite($this->s, "$tag $line {" . strlen($literal) . "}\r\n");
			$cont = fgets($this->s);
			if ($cont === false || $cont[0] !== '+') {
				throw new RuntimeException("IMAP: no continuation for $line: $cont");
			}
			fwrite($this->s, $literal . "\r\n");
		}
		$all = '';
		while (($l = fgets($this->s)) !== false) {
			$all .= $l;
			if (str_starts_with($l, "$tag ")) {
				if (!str_starts_with($l, "$tag OK")) {
					throw new RuntimeException("IMAP $line: $l");
				}
				return $all;
			}
		}
		throw new RuntimeException('IMAP connection closed');
	}
}

/** A multipart/alternative message (GreenMail cannot open single-part mail, see docs/lessons.md). */
function message(array $m, string $to, int $when): string {
	$boundary = 'atrium-' . bin2hex(random_bytes(6));
	$id = '<' . bin2hex(random_bytes(8)) . '@' . (explode('@', $m['from'][1])[1]) . '>';
	$h = [
		'From: ' . ($m['from'][0] === '' ? $m['from'][1] : '"' . $m['from'][0] . '" <' . $m['from'][1] . '>'),
		'To: ' . $to,
		'Subject: ' . $m['subject'],
		'Date: ' . date(DATE_RFC2822, $when),
		'Message-ID: ' . $id,
		'MIME-Version: 1.0',
	];
	foreach ($m['headers'] ?? [] as $extra) {
		$h[] = $extra;
	}
	$h[] = "Content-Type: multipart/alternative; boundary=\"$boundary\"";
	$text = $m['body'];
	$html = '<html><body><p>' . nl2br(htmlspecialchars($text)) . '</p></body></html>';
	return implode("\r\n", $h) . "\r\n\r\n"
		. "--$boundary\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n" . str_replace("\n", "\r\n", $text) . "\r\n"
		. "--$boundary\r\nContent-Type: text/html; charset=utf-8\r\n\r\n" . $html . "\r\n"
		. "--$boundary--\r\n";
}

$now = time();
$day = 86400;
$mails = [
	'alice' => [
		['from' => ['Bob Durand', 'bob@atrium.test'], 'subject' => 'Dîner samedi ?', 'ago' => 3600,
			'body' => "Salut Alice,\n\nTu es libre samedi soir pour un dîner ? Dis-moi avant jeudi.\n\nBob"],
		['from' => ['Claire Petit', 'claire@example.org'], 'subject' => 'Réunion projet jeudi 14h', 'ago' => 5 * 3600,
			'body' => "Bonjour,\n\nJe propose une réunion de lancement jeudi à 14h, salle B (ou en visio).\nMerci de confirmer ta présence.\n\nClaire"],
		['from' => ['Électricité Exemple', 'factures@energie.example.com'], 'subject' => 'Votre facture de novembre est disponible', 'ago' => $day,
			'body' => "Bonjour Alice Martin,\n\nVotre facture n° 2026-11-0042 d'un montant de 64,20 € est disponible.\nÉchéance de paiement : le 30 novembre.\n\nService client"],
		['from' => ['Le Journal du Code', 'news@newsletter.example.net'], 'subject' => 'Cette semaine : 10 astuces Git', 'ago' => 2 * $day,
			'headers' => ['List-Unsubscribe: <https://newsletter.example.net/unsubscribe?u=demo>, <mailto:unsubscribe@newsletter.example.net>', 'List-Unsubscribe-Post: List-Unsubscribe=One-Click'],
			'body' => "Au sommaire cette semaine : rebase interactif, worktrees, bisect…\n\nSe désinscrire : https://newsletter.example.net/unsubscribe?u=demo"],
		['from' => ['Boutique Exemple', 'commandes@shop.example.com'], 'subject' => 'Votre commande #48213 a été expédiée', 'ago' => 3 * $day,
			'body' => "Bonne nouvelle ! Votre commande #48213 (1 casque audio) a été expédiée.\nLivraison prévue : dans 2 jours."],
		// Scam sample: the display name claims a bank, the address domain does not match.
		['from' => ['Banque Nationale - Sécurité', 'alerte@secure-bnq-verif.example.biz'], 'subject' => 'URGENT : votre compte sera suspendu', 'ago' => 4 * 3600,
			'body' => "Cher client,\n\nUne activité inhabituelle a été détectée. Confirmez vos identifiants sous 24h :\nhttp://secure-bnq-verif.example.biz/login\n\nLe service sécurité"],
		['from' => ['GitHub Exemple', 'noreply@code.example.com'], 'subject' => '[atrium] Nouvelle issue : le calendrier ne charge pas', 'ago' => 6 * $day,
			'body' => "Une nouvelle issue a été ouverte sur le dépôt atrium."],
		['from' => ['Maman', 'maman@example.org'], 'subject' => 'Photos des vacances', 'ago' => 70 * $day,
			'body' => "Coucou ma chérie, voici enfin les photos de l'été. Bisous !"],
	],
	'bob' => [
		['from' => ['Alice Martin', 'alice@atrium.test'], 'subject' => 'Re: Dîner samedi ?', 'ago' => 1800,
			'body' => "Avec plaisir ! 20h chez moi ?\n\nAlice"],
		['from' => ['Club de sport', 'contact@club.example.org'], 'subject' => 'Rappel : cotisation annuelle', 'ago' => 2 * $day,
			'body' => "Bonjour Bob,\n\nPensez à renouveler votre cotisation avant le 1er décembre."],
		['from' => ['Promo Flash', 'deals@promo.example.com'], 'subject' => '-70% sur tout le site ce week-end !!!', 'ago' => $day,
			'headers' => ['List-Unsubscribe: <https://promo.example.com/u/bob>'],
			'body' => "Profitez de nos offres exceptionnelles."],
	],
];

foreach ($mails as $uid => $list) {
	$imap = new Imap(MAIL_HOST, 3143);
	$imap->cmd("LOGIN $uid@atrium.test " . MAIL_PASSWORD);
	// GreenMail starts with INBOX only; Mail needs Sent/Drafts/Trash to send.
	foreach (['Sent', 'Drafts', 'Trash', 'Archive', 'Junk'] as $box) {
		try {
			$imap->cmd("CREATE $box");
		} catch (RuntimeException) {
			// already there
		}
	}
	foreach ($list as $m) {
		$when = $now - $m['ago'];
		$flags = $m['ago'] > 2 * $day ? '(\\Seen)' : '()';
		$imap->cmd('APPEND INBOX ' . $flags . ' "' . date('d-M-Y H:i:s O', $when) . '"', message($m, "$uid@atrium.test", $when));
	}
	$imap->cmd('LOGOUT');
	say("mail: " . count($list) . " messages for $uid");

	occ('mail:account:create-imap', $uid, DEMO_USERS[$uid][0], "$uid@atrium.test",
		MAIL_HOST, '3143', 'none', "$uid@atrium.test", MAIL_PASSWORD,
		MAIL_HOST, '3025', 'none', "$uid@atrium.test", MAIL_PASSWORD);
}

$db = \OCP\Server::get(\OCP\IDBConnection::class);
$q = $db->getQueryBuilder();
$rows = $q->select('id', 'user_id')->from('mail_accounts')->executeQuery()->fetchAll();
foreach ($rows as $r) {
	occ('mail:account:sync', '-f', (string)$r['id']);
	say("mail: synced account {$r['id']} ({$r['user_id']})");
}

// ---------------------------------------------------------------- calendar + tasks

$cal = \OCP\Server::get(\OCA\DAV\CalDAV\CalDavBackend::class);
function ics(string $body): string {
	return "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Atrium//demo//EN\r\n$body\r\nEND:VCALENDAR\r\n";
}
function utc(int $t): string {
	return gmdate('Ymd\THis\Z', $t);
}
$today = strtotime('today 00:00');
foreach (array_keys(DEMO_USERS) as $uid) {
	$principal = "principals/users/$uid";
	$calendars = $cal->getCalendarsForUser($principal);
	$id = null;
	foreach ($calendars as $c) {
		if ($c['uri'] === 'personal') {
			$id = (int)$c['id'];
		}
	}
	$id ??= $cal->createCalendar($principal, 'personal', ['{DAV:}displayname' => 'Personnel', '{http://apple.com/ns/ical/}calendar-color' => '#3b82f6']);
	$events = [
		['Réunion projet', $today + 3 * $day + 14 * 3600, 3600, ''],
		['Dîner', $today + 5 * $day + 20 * 3600, 2 * 3600, ''],
		['Sport', $today + $day + 18 * 3600, 3600, "RRULE:FREQ=WEEKLY;COUNT=10\r\n"],
		['Dentiste', $today + 9 * 3600 + 30 * 60, 1800, ''],
	];
	foreach ($events as $i => [$title, $start, $len, $extra]) {
		$uidEv = "demo-$uid-ev-$i";
		$cal->createCalendarObject($id, "$uidEv.ics", ics("BEGIN:VEVENT\r\nUID:$uidEv\r\nDTSTAMP:" . utc($now) . "\r\nDTSTART:" . utc($start) . "\r\nDTEND:" . utc($start + $len) . "\r\nSUMMARY:$title\r\n{$extra}END:VEVENT"));
	}
	$tasks = [['Payer la facture d\'électricité', $today + 18 * $day], ['Préparer la réunion projet', $today + 3 * $day], ['Renouveler la cotisation du club', $today + 19 * $day]];
	foreach ($tasks as $i => [$title, $due]) {
		$uidTd = "demo-$uid-td-$i";
		$cal->createCalendarObject($id, "$uidTd.ics", ics("BEGIN:VTODO\r\nUID:$uidTd\r\nDTSTAMP:" . utc($now) . "\r\nDUE:" . utc($due) . "\r\nSUMMARY:$title\r\nSTATUS:NEEDS-ACTION\r\nEND:VTODO"));
	}
	say("calendar: events and tasks for $uid");
}

// ---------------------------------------------------------------- contacts

$card = \OCP\Server::get(\OCA\DAV\CardDAV\CardDavBackend::class);
$people = [['Bob Durand', 'bob@atrium.test', '+33 6 00 00 00 01'], ['Alice Martin', 'alice@atrium.test', '+33 6 00 00 00 02'], ['Claire Petit', 'claire@example.org', '+33 6 00 00 00 03']];
foreach (array_keys(DEMO_USERS) as $uid) {
	$principal = "principals/users/$uid";
	$books = $card->getAddressBooksForUser($principal);
	$bookId = null;
	foreach ($books as $b) {
		if ($b['uri'] === 'contacts') {
			$bookId = (int)$b['id'];
		}
	}
	$bookId ??= $card->createAddressBook($principal, 'contacts', ['{DAV:}displayname' => 'Contacts']);
	foreach ($people as $i => [$fn, $email, $tel]) {
		if (str_starts_with($email, "$uid@")) {
			continue;
		}
		$cuid = "demo-$uid-c-$i";
		$card->createCard($bookId, "$cuid.vcf", "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:$cuid\r\nFN:$fn\r\nEMAIL;TYPE=INTERNET:$email\r\nTEL;TYPE=CELL:$tel\r\nEND:VCARD\r\n");
	}
	say("contacts for $uid");
}

// ---------------------------------------------------------------- files

$rootFolder = \OCP\Server::get(\OCP\Files\IRootFolder::class);
foreach (array_keys(DEMO_USERS) as $uid) {
	$home = $rootFolder->getUserFolder($uid);
	if (!$home->nodeExists('Documents')) {
		$home->newFolder('Documents');
	}
	if (!$home->nodeExists('Bienvenue.md')) {
		$home->newFile('Bienvenue.md', "# Bienvenue sur Atrium (démo)\n\nCompte de démonstration de la stack de dev.\n");
	}
	if (!$home->nodeExists('Documents/Liste de courses.txt')) {
		$home->get('Documents')->newFile('Liste de courses.txt', "- pain\n- lait\n- café\n");
	}
	say("files for $uid");
}

say('done');
