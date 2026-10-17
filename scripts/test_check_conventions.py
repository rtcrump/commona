#!/usr/bin/env python3
"""Self-tests for check_conventions.py: must-pass and must-fail cases, plus a real throwaway git repo."""
import json, os, subprocess, sys, tempfile, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import check_conventions as cc

AG = "Authored-by-agent: cursor/bc-1234\nModel: example-model-1"
MAIN = "QA: chatgpt round 2 pass\nApproved-by: trafford"
BOT = "commona-bot@users.noreply.github.com"

def msg(subject, *trailer_blocks, body="Body text."):
    t = "\n".join(trailer_blocks)
    return f"{subject}\n\n{body}\n\n{t}" if t else f"{subject}\n\n{body}"

class Commits(unittest.TestCase):
    def ok(self, m, mode="pr", email=BOT):
        self.assertEqual(cc.check_commit(email, m, mode), [], m)
    def bad(self, m, needle, mode="pr", email=BOT):
        errs = cc.check_commit(email, m, mode)
        self.assertTrue(any(needle in e for e in errs), f"{needle!r} not in {errs}")

    # must pass
    def test_pass_agent(self): self.ok(msg("feat(sharing): add None default", AG))
    def test_pass_agent_refs(self): self.ok(msg("test(audit): L2 tamper test", AG, "Refs: T1"))
    def test_pass_community(self): self.ok(msg("fix(wake): retry jitter", "Authored-by-agent: community/some-user/cursor\nModel: m"))
    def test_pass_human(self): self.ok(msg("fix(ci): emergency pin", "Authored-by: human/trafford"), email="t@example.test")
    def test_pass_main(self): self.ok(msg("feat(room): join auth", AG, MAIN), mode="main")
    def test_pass_qa_fail_on_branch(self): self.ok(msg("fix(room): p5", AG, "QA: chatgpt round 1 fail"))
    def test_merge_commit_skipped(self): self.ok("Merge pull request #3 from x/y\n\nwhatever")
    def test_pass_grok_agent(self): self.ok(msg("feat(room): x", "Authored-by-agent: grok/grok-build\nModel: grok-build"))
    def test_docs_components_match_checker(self):
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        path = os.path.join(root, "docs", "conventions.md")
        with open(path, encoding="utf-8") as f:
            text = f.read()
        prefix = "- component: `"
        line = next(item for item in text.splitlines() if item.startswith(prefix))
        documented = set(line[len(prefix):-1].split())
        self.assertEqual(documented, set(cc.COMPONENTS.split("|")))

    def test_trailer_block_spec(self):
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "trailer-block-spec.json")
        with open(path) as f:
            spec = json.load(f)
        for case in spec["cases"]:
            parsed, _bad = cc.trailers(case["message"])
            self.assertEqual(parsed, [tuple(pair) for pair in case["trailers"]], case["name"])

    def test_pass_cursor_commona_build(self):
        self.ok(msg("ci(ci): check the build", "Authored-by-agent: cursor/commona-build\nModel: cursor"))
    def test_pass_split_trailer_block(self):
        # Exact message of 70da75f: a blank line splits the two trailers.
        self.ok("fix(ci): quote claude review json schema\n\nAuthored-by-agent: cursor/commona-cos\n\nModel: grok-bot")
    def test_pass_pr10_b10a681(self):
        self.ok(
            "docs(readme): write a warmer, fuller welcome\n\n"
            "Rewrite the milestone 1 page in a warmer voice. Keep the one-link join marked as coming at launch, "
            "describe today's setup without naming a product, and tie each behavior to the tests.\n\n"
            "Authored-by-agent: grok/grok-build\n"
            "Model: grok-build"
        )
    def test_pass_pr10_1bc3fe9(self):
        self.ok("docs(readme): add commona icon to header\n\nAuthored-by-agent: grok/grok-build\nModel: grok-build")
    def test_pass_demo_component(self):
        self.ok(msg("feat(demo): show the room", "Authored-by-agent: grok/grok-build\nModel: grok-build"))

    # must fail
    def test_fail_no_trailer(self): self.bad(msg("feat(room): x"), "missing authorship")
    def test_fail_subject_only(self): self.bad("feat(room): x", "missing authorship")
    def test_fail_bad_subject(self): self.bad(msg("Added stuff", AG), "subject must be")
    def test_fail_unknown_component(self): self.bad(msg("feat(ui): x", AG), "subject must be")
    def test_fail_long_subject(self): self.bad(msg("feat(room): " + "x" * 70, AG), "longer than 72")
    def test_fail_agent_no_model(self): self.bad(msg("feat(room): x", "Authored-by-agent: cursor/bc-1"), "requires a Model")
    def test_fail_bad_agent_value(self): self.bad(msg("feat(room): x", "Authored-by-agent: me\nModel: m"), "bad Authored-by-agent")
    def test_fail_unknown_agent(self):
        self.bad(msg("ci(ci): check the build", "Authored-by-agent: unknown/not-a-build\nModel: unknown"), "bad Authored-by-agent")
    def test_fail_both(self): self.bad(msg("feat(room): x", AG, "Authored-by: human/trafford"), "both")
    def test_fail_human_bad_value(self): self.bad(msg("feat(room): x", "Authored-by: trafford"), "want human/", email="t@example.test")
    def test_fail_bot_as_human(self): self.bad(msg("feat(room): x", "Authored-by: human/trafford"), "bot identity")
    def test_fail_typo_key(self): self.bad(msg("feat(room): x", "Authored-By-Agent: cursor/bc-1\nModel: m"), "unknown trailer")
    def test_fail_bad_qa(self): self.bad(msg("feat(room): x", AG, "QA: looks good"), "bad QA")
    def test_fail_round4(self): self.bad(msg("feat(room): x", AG, "QA: chatgpt round 4 pass"), "bad QA")
    def test_fail_wrong_approver(self): self.bad(msg("feat(room): x", AG, "Approved-by: someone"), "must be 'trafford'")
    def test_fail_dup(self): self.bad(msg("feat(room): x", AG, "Model: other"), "more than once")
    def test_fail_main_no_qa(self): self.bad(msg("feat(room): x", AG, "Approved-by: trafford"), "needs 'QA", mode="main")
    def test_fail_main_qa_fail(self): self.bad(msg("feat(room): x", AG, "QA: chatgpt round 3 fail\nApproved-by: trafford"), "needs 'QA", mode="main")
    def test_fail_main_no_approval(self): self.bad(msg("feat(room): x", AG, "QA: chatgpt round 1 pass"), "Approved-by: trafford", mode="main")
    def test_fail_malformed_line(self): self.bad(msg("feat(room): x", AG + "\nnot a trailer"), "malformed")
    def test_fail_body_between_trailers(self):
        self.bad(
            "feat(room): x\n\nAuthored-by-agent: cursor/bc-1234\n\n"
            "A body paragraph of prose sits between the trailers.\n\nModel: x",
            "missing authorship",
        )

class Labels(unittest.TestCase):
    def errs(self, labels, files=(), human=0, mode="pr"):
        return cc.check_labels(labels.split(","), list(files), human, mode)
    def test_pass_basic(self): self.assertEqual(self.errs("agent:cursor"), [])
    def test_pass_critical(self): self.assertEqual(self.errs("agent:cursor,critical-core", ["src/audit/log.ts"]), [])
    def test_pass_human(self): self.assertEqual(self.errs("agent:cursor,human-edit", human=1), [])
    def test_pass_merge(self): self.assertEqual(self.errs("agent:cursor,qa-round-2,agent:chatgpt-qa", mode="merge"), [])
    def test_pass_grok_label(self): self.assertEqual(self.errs("agent:grok-build"), [])
    def test_fail_grok_and_cursor(self):
        self.assertTrue(self.errs("agent:grok-build,agent:cursor"))
        self.assertTrue(self.errs("agent:grok-build,agent:community"))
    def test_fail_no_author(self): self.assertTrue(self.errs("critical-core"))
    def test_fail_both_agents(self): self.assertTrue(self.errs("agent:cursor,agent:community"))
    def test_fail_missing_human_edit(self): self.assertTrue(self.errs("agent:cursor", human=1))
    def test_fail_spurious_human_edit(self): self.assertTrue(self.errs("agent:cursor,human-edit", human=0))
    def test_fail_missing_critical(self):
        for f in ("src/sharing/x.ts", "src/audit/a.ts", "src/auth/t.ts", "src/room/membership.ts"):
            self.assertTrue(self.errs("agent:cursor", [f]), f)
    def test_noncritical_ok(self): self.assertEqual(self.errs("agent:cursor", ["src/wake/queue.ts", "src/room/feed.ts"]), [])
    def test_fail_two_rounds(self): self.assertTrue(self.errs("agent:cursor,qa-round-1,qa-round-2"))
    def test_fail_unknown_round(self): self.assertTrue(self.errs("agent:cursor,qa-round-4"))
    def test_fail_merge_no_qa(self): self.assertTrue(self.errs("agent:cursor", mode="merge"))
    def test_fail_merge_no_report(self): self.assertTrue(self.errs("agent:cursor,qa-round-1", mode="merge"))

class RealGit(unittest.TestCase):
    """End to end through the CLI against a throwaway local git repo (local only, never pushed)."""
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.g("init", "-q", "-b", "main")
        self.g("config", "user.email", BOT); self.g("config", "user.name", "commona-bot")
        self.commit("chore(ci): base", AG + "\n" + MAIN)
        self.base = self.g("rev-parse", "HEAD").strip()
    def g(self, *a):
        return subprocess.run(["git", "-C", self.d, *a], capture_output=True, text=True, check=True).stdout
    def commit(self, subject, trailers):
        self.g("commit", "-q", "--allow-empty", "-m", f"{subject}\n\nBody.\n\n{trailers}")
    def cli(self, mode, extra=()):
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "check_conventions.py")
        head = self.g("rev-parse", "HEAD").strip()
        return subprocess.run([sys.executable, script, "git", "--base", self.base, "--head", head, "--mode", mode, *extra],
                              cwd=self.d, capture_output=True, text=True)
    def test_good_pr(self):
        self.commit("feat(room): a", AG); self.commit("test(room): R1", AG)
        r = self.cli("pr"); self.assertEqual(r.returncode, 0, r.stdout)
    def test_bad_pr(self):
        self.commit("feat(room): a", AG); self.commit("wip", "")
        r = self.cli("pr"); self.assertEqual(r.returncode, 1, r.stdout); self.assertIn("missing authorship", r.stdout)
    def test_human_flag(self):
        self.g("config", "user.email", "t@example.test")
        self.commit("fix(ci): pin", "Authored-by: human/trafford")
        out = os.path.join(self.d, "h.txt")
        r = self.cli("pr", ["--human-out", out]); self.assertEqual(r.returncode, 0, r.stdout)
        self.assertEqual(open(out).read(), "1")
    def test_main_needs_approval(self):
        self.commit("feat(room): a", AG)
        self.assertEqual(self.cli("main").returncode, 1)
        self.commit("feat(room): b", AG + "\n" + MAIN)
        self.g("reset", "-q", "--hard", "HEAD")  # keep both; base..head includes the bad one
        self.assertEqual(self.cli("main").returncode, 1)

if __name__ == "__main__":
    unittest.main(verbosity=2)
