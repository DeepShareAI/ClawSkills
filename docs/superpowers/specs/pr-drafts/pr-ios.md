# fix(calendar): make live to-do cards appear and stop confirmed cards bouncing back

**Branch:** `feat/general-todo-card`
**Commit:** `a1fb5f57629cb6848351c0569d5142f2e83203a8`

## Summary

iOS Layer 1 of the general to-do card design (`docs/superpowers/specs/2026-06-09-brainstorming-skill-design.md`) renders `type="todo"` rows generically in the Calendar list and refreshes them on a `skill_data_updated` SSE whose `type=="todo"`. Two MUST-FIX defects broke that loop:

1. **Dead SSE to-do refresh.** Both live emitters posted only `userInfo ["skill": skill]`, dropping the server-provided data `type`. `CalendarListView`'s `type=="todo"` refresh branch (`CalendarListView.swift:92`) therefore never fired, so a live brainstorming to-do card never appeared in real time.
2. **Confirmed card bounces back.** The server todo GET has no status filter and a confirmed row is **not** deleted (it stays `status="confirmed"`). The next `loadTodos()` re-mapped the just-confirmed row back into an actionable card, silently undoing `confirmTodo()`'s optimistic removal.

This PR fixes both so live cards arrive and stay confirmed.

## Changes

- `Sources/JavisApp/agent/services/AgentSessionTitleSSEService.swift` — `handleSkillDataUpdated` now extracts `type` from the SSE envelope (top-level or nested under `data`, mirroring the existing `skill` tolerance) and includes it in the `.skillDataUpdated` `userInfo`. This is the **primary** fix: in production `skill_data_updated` reaches iOS via the SSE path.
- `Sources/JavisApp/agent/services/AgentMessageReceiver.swift` — legacy WS path: new static helper `extractSkillDataType(from:)` pulls `data.type` (or a top-level `type` that is **not** the envelope marker `"skill_data_updated"`, avoiding the collision with the envelope's own `type` field) and includes it in the `userInfo`. Defensive / for-consistency.
- `Sources/JavisApp/calendar/RemoteTodoCardsProvider.swift` — `mapCards` now drops rows where `status=="confirmed"` (the `SkillDataTodoReadItem.status` field was already decoded but previously discarded).
- `Sources/JavisApp/tests/AgentPushUnreadSSEUnitTests.swift` — 2 XCTest cases pinning `type` propagation (top-level and under-envelope shapes).
- `Sources/JavisApp/tests/TodoCardsProviderTests.swift` — `testDropsConfirmedRows`.

## Testing

```
xcodebuild -scheme HiJavis build
```

Result: **BUILD SUCCEEDED**. Test sources under `Sources/JavisApp/tests/` compile into the HiJavis app target, so the green build also compiles the new test cases. Note this is a compile-only `build` action, not `xcodebuild test`; the XCTest cases are verified to compile but were not executed in this run. To execute the full suite:

```
xcodebuild -scheme HiJavis -destination 'platform=iOS Simulator,name=iPhone 15' test
```

## Risk / blast radius

Low–moderate. Three focused edits: two add a field to existing `userInfo` dictionaries (additive — consumers that ignore `type` are unaffected), and one adds a filter clause in `mapCards`. The `type=event` rendering path and the `type=todo` confirm/discard handlers are unchanged. Only the 5 task files were staged and committed; pre-existing unrelated working-tree changes (`HiJavis.xcodeproj/project.pbxproj`, `Sources/JavisApp/Info.plist`, `Sources/JavisKeyboard/Info.plist`, `project.yml`) were left untouched and unstaged. **Not pushed.**

## Notes for reviewer

Cross-layer invariants this PR upholds:

- **skill-optional aggregate fetch:** iOS continues to call the to-do GET with `skill` **omitted**, relying on the server returning all of the user's todo rows across skills (Layer 1 server change). This PR does not change the request shape — `skill` stays omitted on GET.
- **null `start_at` handling:** `type=todo` rows have no date; they sort to today/top in the Calendar list. The decode/map path tolerates `null` `start_at`/`end_at` and this PR does not change that.
- **per-item skill:** each row carries its own `skill`; confirm/discard target one row by that row's `skill`/`type`/`dedup_key`. Preserved — the confirm filter added here keys off `status`, not `skill`.
- **backward-compat for `type=event`:** the `type=todo` path is the only path touched for confirm/discard; event rendering and refresh are unchanged.
- **Confirm copies prompt:** the Confirm handler writes `payload.prompt` to `UIPasteboard` and then POSTs confirm (status→confirmed). The bounce-back fix (drop `status=="confirmed"` rows) is what makes that optimistic removal stick across the next refresh.
- **SSE vs WS:** `AgentSessionTitleSSEService` (SSE) is the production path and the primary fix. `AgentMessageReceiver` is the legacy WS path; its fix is defensive and tolerates both nested (`data.type`) and flattened envelope shapes, and deliberately ignores a top-level `type` equal to the envelope marker `"skill_data_updated"`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
