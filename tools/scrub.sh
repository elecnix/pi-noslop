#!/usr/bin/env bash
#
# Fixture scrub. This repo is public, and its fixtures are written by agents
# that also work in private repos. A test fixture here once carried a
# sentence lifted verbatim from a private writing guide.
#
# Two patterns run.
#
# The baseline is committed and names nothing private. It catches the shapes
# a leak takes: a ticket reference, an internal hostname, a private address.
#
# The second comes from the SCRUB_PATTERN repository secret, which is where
# the private vocabulary lives. Writing those words into this file would
# publish the very thing the check exists to keep out.
#
# The secret is required. A scrub that passes because its pattern is empty
# reports green while checking nothing, which is worse than no scrub at all.
# Fork pull requests are the one exception: GitHub withholds secrets from
# them by design, and a fork contributor has no access to the vocabulary in
# the first place.
#
# grep exits 1 when it finds nothing. That is the outcome this script wants,
# so every call absorbs the status and the decision is made on the output.
#
# Findings are reported as `file:line` without the matching text. See scan().

set -uo pipefail

fail=0

# scan <label> <case-flag> <pattern>. The case flag is `-i` or empty:
# ticket references are uppercase by convention and match case-sensitively,
# so a lowercase build tag such as a model name does not trip them.
#
# Only `file:line` is printed. Printing the matching text would write the
# leaked sentence into a public build log, which is the outcome this script
# exists to prevent. GitHub masks a secret's literal value, but the secret
# here is a regex alternation, so an individual matched word is not masked.
# Set SCRUB_SHOW_MATCHES=1 to see the text when running this locally.
scan() {
	local label="$1" caseflag="$2" pattern="$3" hits
	hits=$(grep -rnE ${caseflag:+"$caseflag"} \
		--exclude-dir=.git \
		--exclude-dir=node_modules \
		--exclude=scrub.sh \
		-- "$pattern" . || true)
	if [ -n "$hits" ]; then
		if [ "${SCRUB_SHOW_MATCHES:-}" = "1" ]; then
			printf 'scrub: %s matched:\n%s\n\n' "$label" "$hits"
		else
			printf 'scrub: %s matched at:\n%s\n\n' \
				"$label" "$(printf '%s\n' "$hits" | cut -d: -f1,2 | sed 's/^/  /')"
		fi
		fail=1
	fi
}

TICKETS='(^|[^A-Za-z0-9])[A-Z]{3,}-[0-9]+'
HOSTS='[a-z0-9-]+\.(internal|corp|intranet)([^a-z0-9-]|$)'
ADDRS='(^|[^0-9.])(10\.[0-9]{1,3}|192\.168|172\.(1[6-9]|2[0-9]|3[01]))\.[0-9]{1,3}\.[0-9]{1,3}([^0-9.]|$)'
scan 'baseline: ticket references' '' "$TICKETS"
scan 'baseline: internal hostnames' '-i' "$HOSTS"
scan 'baseline: private addresses' '' "$ADDRS"

if [ -n "${SCRUB_PATTERN:-}" ]; then
	scan 'SCRUB_PATTERN' '-i' "$SCRUB_PATTERN"
elif [ "${SCRUB_FORK:-}" = "true" ]; then
	echo 'scrub: fork pull request. GitHub withholds the SCRUB_PATTERN secret here by design, so only the baseline ran.'
else
	echo 'scrub: the SCRUB_PATTERN repository secret is empty.'
	echo 'scrub: set it to an extended-regex alternation of the vocabulary this repo must never carry.'
	fail=1
fi

if [ "$fail" -eq 0 ]; then
	echo 'scrub: clean.'
fi
exit "$fail"
