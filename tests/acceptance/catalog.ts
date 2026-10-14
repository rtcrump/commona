import type { AcceptanceTestId } from "../../contract/index.js";
import { WORDING } from "./wording.js";

export interface AcceptanceCase {
  id: AcceptanceTestId;
  spec: "T1" | "T2" | "T3" | "T4" | "T5" | "T6";
  wording: string;
  /** Copied from the owning spec. */
  procedures: readonly string[];
}

export const ACCEPTANCE_CASES: readonly AcceptanceCase[] = [
  {
    id: "R1",
    spec: "T2",
    wording: WORDING.R1,
    procedures: ["`test_R1_a1_posts_a2_reads` (with sharing opened via fixture helper)."],
  },
  {
    id: "R2",
    spec: "T2",
    wording: WORDING.R2,
    procedures: [
      "`test_R2_non_member_refused_and_logged`: AX (owner O3) posts and reads → 403 both times, two `join_refused`/refused entries in log with AX and O3.",
    ],
  },
  {
    id: "R3",
    spec: "T2",
    wording: WORDING.R3,
    procedures: [
      "`test_R3_ten_posts_logged_with_owner`: A1 and A2 alternate 10 posts; log has exactly 10 `post` entries, each with correct ownerId.",
    ],
  },
  {
    id: "W1",
    spec: "T5",
    wording: WORDING.W1,
    procedures: [
      "`test_W1_wake_within_60s_10_of_10` — 10 posts by A1; fake webhook for A2 records arrival; all 10 arrive, each latency < 60 s (report max latency in PR body).",
    ],
  },
  {
    id: "W2",
    spec: "T5",
    wording: WORDING.W2,
    procedures: [
      "`test_W2_down_retries_then_email_logged` — A2 webhook returns 503/connection refused; assert ≥1 retry logged, one email in sink to A2's address, `wake_fallback_email` logged; plus case where email also fails → `wake_failed` logged and owner notified (nothing silent).",
    ],
  },
  {
    id: "W3",
    spec: "T6",
    wording: WORDING.W3,
    procedures: [
      "`test_W3_no_self_wake` — A1 posts; A1's webhook receives nothing.",
      "`test_W3_stops_after_3_rounds` — fake A1/A2 auto-reply bots reply to each wake; exactly 3 agent-to-agent rounds of wakes occur, then `loop_stop` logged and no 4th wake within 60 s.",
    ],
  },
  {
    id: "S1",
    spec: "T3",
    wording: WORDING.S1,
    procedures: [
      "`test_S1_none_a2_sees_nothing` — A1 posts message + `tree.md`; A2 feed is empty (and wake payload, once T5 lands, carries no content).",
    ],
  },
  {
    id: "S2",
    spec: "T3",
    wording: WORDING.S2,
    procedures: ["`test_S2_messages_hides_files` — A2 sees the message, not `tree.md`."],
  },
  {
    id: "S3",
    spec: "T3",
    wording: WORDING.S3,
    procedures: ["`test_S3_messages_files_both`."],
  },
  {
    id: "S4",
    spec: "T3",
    wording: WORDING.S4,
    procedures: [
      "`test_S4_a2_cannot_change_o1_setting` — attempts by A2's token and by O2 to change O1→O2 row → 403, row unchanged, `setting_change_refused` logged with A2/O2.",
    ],
  },
  {
    id: "S5",
    spec: "T3",
    wording: WORDING.S5,
    procedures: [
      "`test_S5_new_room_defaults_none` — fresh room, every pair = none, and A2 sees nothing without any setup.",
    ],
  },
  {
    id: "P1",
    spec: "T4",
    wording: WORDING.P1,
    procedures: [
      "`test_P1_name_in_message_blocked` — blocked, O1 notified (mail sink has 1 mail to o1@example.test), log has `block`.",
    ],
  },
  {
    id: "P2",
    spec: "T4",
    wording: WORDING.P2,
    procedures: ["`test_P2_bad_file_blocked` — upload `notes-with-patient.md` → blocked."],
  },
  {
    id: "P3",
    spec: "T4",
    wording: WORDING.P3,
    procedures: [
      "`test_P3_health_number_and_dob_blocked` — two separate messages, each blocked with the right category.",
    ],
  },
  {
    id: "P4",
    spec: "T4",
    wording: WORDING.P4,
    procedures: [
      "`test_P4_no_false_positives` — `tree.md` + all 20 `normal-messages.json` pass; block count = 0.",
    ],
  },
  {
    id: "P5",
    spec: "T4",
    wording: WORDING.P5,
    procedures: [
      '`test_P5_name_in_filename_or_metadata` — clean body named `jane-testpatient.md` blocked; clean file with metadata title "Jane Testpatient" blocked.',
    ],
  },
  {
    id: "L1",
    spec: "T1",
    wording: WORDING.L1,
    procedures: [
      "`test_L1_every_action_logged`: the harness records every action it performed (id, agent, owner, expected result); after the run, each must match exactly one log entry with time, agent, owner and result. Unmatched either way = fail.",
    ],
  },
  {
    id: "L2",
    spec: "T1",
    wording: WORDING.L2,
    procedures: [
      "`test_L2_update_refused`",
      "`test_L2_delete_refused` (triggers refuse)",
      "`test_L2_tamper_detected` (edit DB file bytes directly / disable trigger in test, then `verify()` reports the broken entry).",
    ],
  },
  {
    id: "L3",
    spec: "T1",
    wording: WORDING.L3,
    procedures: [
      "`test_L3_owner_sees_only_own`: entries for A1 and A2 exist; O2 gets only A2's; O2 asking for `owner=O1` gets 403 and that refusal is itself logged.",
    ],
  },
];
