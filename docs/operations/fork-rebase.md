# Rebasing the fork's `dev` onto main

`dev` is upstream main (`pingdotgg/t3code`) plus this fork's features, one commit per feature.
This page is for the agent that next rebases `dev` onto a newer main. It records what `dev`
deliberately leaves out of main, what it must keep, and the checks that caught real problems last
time.

Last rebase: 2026-11-01, onto main `5732bbee39`.

## The one rule

**Keep everything from main unless it directly clashes with a fork feature.** When something clashes:

1. Ask the developer which side wins before removing anything new.
2. Remove main's version in its own `chore: remove main's … in favor of ours` commit, placed just
   before the fork feature that replaces it. Never hide a removal inside a feature commit.
3. Remove only the part that clashes. Main's pull requests often carry server, agent, contract or
   bug-fix parts that have nothing to do with the clash. Keep those.
4. Look for small fixes main built on top of what you removed. If a fix also applies to the fork's
   version, bring it back (see "Brought back after removal" below for two examples).

## Before you start

- Use `upstream/main` (or `origin/main`, which mirrors it). The local `main` branch is old; do not
  rebase onto it.
- Make a backup branch first: `git branch backup/dev-before-<date>-rebase dev`.
- Never use `git stash`. The developer keeps stashes in GitHub Desktop, and a stash pop can mix
  them up. To set files aside, copy them somewhere outside the repo.
- Check `git status` first. Uncommitted work may belong to another chat; leave it alone.
- Turn on git's conflict memory if it is still off: `git config rerere.enabled true`. It replays a
  fix you already made when the exact same clash comes back.

## What `dev` leaves out of main, on purpose

Each item was the developer's decision. Do not bring these back without asking.

### Main's side chat (#26901, follow-ups #28264, #28266)

Commit: `chore: remove main's side chat in favor of ours`. Both features marked a chat as a side
chat under the same name. The fork's side chat (Claude only, `/btw`, up to three tabs, deleted on
settle) wins.

- Removed: `lineage.sideChat`, the side-chat fork option, the server's side-chat capability and
  delete-if-unused, the side-chat context handoff, deleting side chats with their parent, side-chat
  rules in checkpoints, search, PR links, storage cleanup and the live chat list, main's side chat
  pane and its own `/side` and `/btw` commands, the phone app's side chats row, the user guide
  section, the evals case.
- Kept (general fork improvements from the same work): a fork of a fork carries its ancestors'
  history; rolled-back runs and cancelled messages stay out of a fork's context; a busy chat can be
  forked through a portable copy of its context; a second pending merge-back is refused; #28265
  (forking skips unused parent data).
- Not needed on `dev`: main's renamed helpers `isSidebarHiddenThread`, `hiddenChildAncestorIds`,
  `inheritedRunFork` and `shellHasPendingUserInput`. They all key off `lineage.sideChat`. The fork's
  side chat uses its own `thread.sideChat` marker and already hides itself, so these would do
  nothing. Expect clashes in those spots when main edits them.

### Main's chat box redesign (#25869, #28057 and the picker fixes on top)

Commit: `chore: remove main's composer redesign in favor of our chat bar`. The fork's one-line chat
bar with its settings card wins.

- Removed: #25869 (always-two-row box, effort as a word, the Effort display setting, the Fast bolt,
  hiding permissions in default mode, the permissions name under a new chat's box), #28057 (one
  model + effort button), #28076, #28162, #28307, the web part of #28409, #26514, #26470. #26514 and
  #26470 only touched main's new box, so they do not apply to `dev`.
- Kept: the server and agent part of #28409 (ACP agents' thinking levels marked `role: "reasoning"`,
  Grok's levels sorted lowest to highest), and main's other chat box fixes (skills loading,
  attachments, IME, reconnecting notice).
- Brought back after removal (commit `fix: bring back two of main's effort fixes`): #28044, which
  hides Ultrathink from effort pickers on web and phone (typing it still works), and the
  `thinking_level` entry from #26929, so Antigravity's thinking level counts as effort. The rest of
  #26929 only fits main's new box.
- Removed after the rebase (commit `chore(web): remove the chat box's shrink on scroll`): the desktop
  chat box that shrinks to one row when you scroll, and its `composerCollapseOnScroll` setting.
  Main removed it in #25869 and the developer does not use it. The phone-width collapsed box, whose
  controls move into the strip below it, stays.

### Main's floating thread details card

The fork's `feat(web): thread details move into the sidebar` replaces the card, so main's later work
on it is gone: compact and essential sizes for short windows, the chat moving aside to fit it
(#25838), and its chat header button. Kept from #26904: choosing which detail rows show (right-click
or Settings → Appearance → Thread details), minus its Lineage option, because lineage has its own
sidebar section.

### Smaller ones

- #26736 (settled drop hint): dropped, because the fork removed the Settled section and settling by
  drag.
- The sidebar's provider update pill: deleted by the developer's choice. Provider updates live in
  Settings and the header update button.
- #22131 (HTML frames always show the full page): `dev` honours the height the agent asks for again
  (`fix(web): inline HTML frames respect the agent's height again`).

## What `dev` keeps that main removed or is retiring

Keep these. They look like dead code next to main, but fork features use them.

- `resolveSidebarV2TopStatus` in `Sidebar.logic.ts`. Main deleted it as unused (#26238). The Done
  shelf uses it through `isSidebarThreadDone`. Its order must match the row label chain in
  `SidebarThreadRow.tsx` (Working, Waiting, Approval, Input, Request, Limited, Failed, Woke, Done).
  If main changes that chain, update this function to match.
- `readEnvironmentSupportsTags`: tags exist only in this fork, and an upstream server does not
  understand them. Main deleted its other support-check helpers only because nothing used them.
- `contextWindowMeterEnabled`: main lists it under Settings → Legacy. The fork's 5-hour limit ring
  only shows when it is on. If main deletes the setting, ask the developer before giving the ring
  its own switch.

## How main's newer pieces fit fork features

- Boring sidebar (Labs) project folders: the fork's tag boxes stay on top and the folders only hold
  untagged chats; Done and In progress stay off in that mode; folder rows keep their branch line
  even though fork chat cards hide it.
- #26195: chats on an unreachable machine stay out of In progress.
- #26874: the sidebar's undo notice sits beside the fork's details button.

## Finding what the rebase dropped

After resolving, check that `dev` lost nothing by accident. This blames every line `dev` removes from
main back to the main commit that wrote it. Everything high on the list should be one of the
deliberate removals above; anything else needs a look.

```bash
git diff -U0 --no-renames upstream/main dev -- . ':!**/agentContextBudget.json' \
  | awk '/^--- a\//{f=substr($0,7)} /^@@/{split($2,a,","); s=substr(a[1],2); n=(a[2]==""?1:a[2]); if(n>0) print f, s","s+n-1}' \
  | while read -r f r; do git blame --line-porcelain -L "$r" upstream/main -- "$f"; done \
  | grep -E '^[0-9a-f]{40} ' | cut -c1-10 | sort | uniq -c | sort -rn | head -40 \
  | while read -r n sha; do echo "$n $(git log -1 --format='%h %ad %s' --date=short "$sha")"; done
```

It takes a minute or two. Old commits can rank high because they last touched lines that a deliberate
removal deletes. On 2026-11-01, #2829 (new orchestrator) was the floating details card's code and
#2312 was the provider update pill. Check what the lines are, not just which commit wrote them.

Also compare the other way: names `dev` adds back that main deleted. Those are either deliberate
(the list above) or leftovers to remove.

## Checks

- Replay with checks on every commit: `vp run check:changed` (format, lint, knip, types, nearby
  tests). Read [Verifying](../../AGENTS.md#verifying) for the rest.
- `agentContextBudget.json` is higher on `dev` than on main because fork features add agent
  instructions and tools. Each commit records its own numbers. When `AgentContextBudget.test.ts`
  fails, set the JSON to the measured values it prints.
- Known failures on the developer's Mac that also fail on plain main: the server install test in
  `ServerEnvironment.test.ts` (macOS reports temp folders as `/private/var`). The guest page's
  "follows the end as replies stream" test has also failed on plain main. Run a failing test on
  main before blaming the rebase.
- Try the merged screens in the app afterwards (side chats, chat bar, sidebar details, lineage) and
  run the evals if model-facing text changed.

## After the rebase

- Pushing a rebased `dev` needs a force push. Ask the developer first.
- Rebase often. A few days of main is much easier to merge than two weeks.
- Update this page: the last rebase date, any new deliberate removals, anything kept or brought
  back.
