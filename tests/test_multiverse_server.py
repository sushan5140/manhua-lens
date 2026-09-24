"""End-to-end and deterministic tests for the interactive Manhua Multiverse server."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch
from urllib import request, error

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("mm_server",ROOT / "multiverse" / "server.py")
SERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVER)

def world():
    return {"version":2,"active":"thread-1","nextId":2,
            "branches":[{"id":"thread-1","name":"Original timeline","events":[]}]}

class EngineTests(unittest.TestCase):
    def setUp(self):
        self.patch=patch.object(SERVER,"provider",return_value=("offline","","",""))
        self.patch.start()
        self.addCleanup(self.patch.stop)
    def test_any_text_is_action_not_a_static_button(self):
        w=world()
        first=SERVER.act(w,"I ask Jae to show me the silver key")
        self.assertEqual(len(first["world"]["branches"][0]["events"]),1)
        self.assertIn("silver key",first["state"]["inventory"])
        self.assertEqual(first["mode"],"offline")
        self.assertEqual(len(w["branches"][0]["events"]),0)
    def test_real_state_gates_clock_repair(self):
        w=SERVER.act(world(),"Take the key")["world"]
        failed=SERVER.act(w,"I restore the missing minute")
        self.assertNotIn("clock_restored",failed["state"]["flags"])
        self.assertIn("cannot skip",failed["state"]["title"].lower())
        w=SERVER.act(w,"Read the ledger of erased futures")["world"]
        repaired=SERVER.act(w,"Repair the clock")
        self.assertIn("clock_restored",repaired["state"]["flags"])
        self.assertEqual(repaired["state"]["scene"],"city")
    def test_leaving_key_prevents_bargain(self):
        w=SERVER.act(world(),"Take the key")["world"]
        w=SERVER.act(w,"Leave the key behind")["world"]
        self.assertNotIn("silver key",SERVER.replay(w["branches"][0])["inventory"])
        w=SERVER.act(w,"Trade my memory to free everyone")["world"]
        self.assertNotIn("memory_traded",SERVER.replay(w["branches"][0])["flags"])
    def test_offline_freeform_emotional_and_destructive_choices_have_different_effects(self):
        w=SERVER.act(world(),"I hug Sori because she is frightened")["world"]
        state=SERVER.replay(w["branches"][0])
        self.assertEqual(state["trust"]["sori"],1)
        self.assertEqual(state["scene"],"station")
        w=SERVER.act(w,"I burn the ledger rather than read it")["world"]
        state=SERVER.replay(w["branches"][0])
        self.assertEqual(state["trust"]["sori"],-1)
        self.assertNotIn("ledger",state["evidence"])
        self.assertEqual(state["scene"],"archive")
        w=SERVER.act(w,"I refuse to restore the clock")["world"]
        self.assertNotIn("clock_restored",SERVER.replay(w["branches"][0])["flags"])

    def test_chat_is_not_action_and_has_independent_state(self):
        w=SERVER.chat(world(),"sori","What happened before?")["world"]
        self.assertEqual(SERVER.replay(w["branches"][0])["turn"],0)
        self.assertIn("haven't made",w["branches"][0]["events"][-1]["reply"])
        w=SERVER.act(w,"Take the silver key")["world"]
        w=SERVER.chat(w,"jae","Do you trust me?")["world"]
        self.assertEqual(SERVER.replay(w["branches"][0])["turn"],1)
        self.assertEqual(w["branches"][0]["events"][-1]["character"],"jae")
    def test_fork_does_not_know_events_from_other_branch(self):
        w=SERVER.act(world(),"Take the key")["world"]
        alternative=copy.deepcopy(w)
        alternative["branches"].append({"id":"thread-2","name":"Different choice","events":[]})
        alternative["active"]="thread-2"
        alternative["nextId"]=3
        response=SERVER.chat(alternative,"jae","Where is the key?")
        self.assertIn("don't have the key",response["reply"])
        self.assertEqual(len(response["world"]["branches"][0]["events"]),1)
    def test_ai_invalid_jump_rejected_without_mutation(self):
        fake=json.dumps({"scene":"city","title":"A repaired clock",
           "narrative":"You restore the clock without collecting a key or any evidence.",
           "changes":{"add_flags":["clock_restored"]},"options":["Ask Sori"]})
        with patch.object(SERVER,"provider",return_value=("groq","","","")):
            with patch.object(SERVER,"call_llm",return_value=fake):
                w=world()
                with self.assertRaisesRegex(ValueError,"continuity"):
                    SERVER.act(w,"Repair the clock anyway")
                self.assertEqual(len(w["branches"][0]["events"]),0)
    def test_character_does_not_receive_other_character_private_chat(self):
        b={"events":[{"type":"chat","character":"jae","text":"My secret is the blue door",
                      "reply":"I understand."},
                     {"type":"action","text":"I search the platform",
                      "title":"A search","scene":"station",
                      "narrative":"You inspect the platform.","changes":{}},
                     {"type":"chat","character":"sori","text":"Hello","reply":"Hello."}]}
        sori=SERVER.trimmed_branch(b,"sori")
        jae=SERVER.trimmed_branch(b,"jae")
        self.assertEqual(len(sori),2)
        self.assertEqual(len(jae),2)
        self.assertNotIn("blue door",str(sori))
        self.assertIn("blue door",str(jae))

    def test_cannot_conjure_key_and_restore_in_same_action(self):
        fake=json.dumps({"scene":"city","title":"A repaired clock",
          "narrative":"The clock repairs itself without prior evidence.",
          "changes":{"add_items":["silver key"],"add_evidence":["ledger"],
                     "add_flags":["clock_restored"]},
          "options":["Wait"]})
        with patch.object(SERVER,"provider",return_value=("groq","","","")):
            with patch.object(SERVER,"call_llm",return_value=fake):
                with self.assertRaisesRegex(ValueError,"continuity"):
                    SERVER.act(world(),"I invent a key and repair everything")

    def test_ai_retries_after_rejecting_impossible_action(self):
        bad=json.dumps({"scene":"city","title":"Conjured restoration",
          "narrative":"Impossible, no key.","changes":{"add_flags":["clock_restored"]},
          "options":["Stop"]})
        good=json.dumps({"scene":"archive","title":"A better way to investigate",
          "narrative":"Your choice starts a search rather than a magical repair.",
          "changes":{"add_evidence":["ledger"]},
          "options":["Find Jae"]})
        with patch.object(SERVER,"provider",return_value=("groq","","","")):
            with patch.object(SERVER,"call_llm",side_effect=[bad,good]) as fake:
                result=SERVER.act(world(),"I try restoring without a key")
        self.assertEqual(fake.call_count,2)
        self.assertEqual(result["state"]["scene"],"archive")
        self.assertEqual(len(result["world"]["branches"][0]["events"]),1)

    def test_ai_real_freeform_output_changes_story(self):
        fake=json.dumps({"scene":"rooftop","title":"An encounter above Seoul",
           "narrative":"You take a route nobody expected. The unchanging clock stares back.",
           "changes":{"add_evidence":["clock_marks"],"trust":{"sori":1}},
           "options":["Look for Jae","Return to the archive"]})
        with patch.object(SERVER,"provider",return_value=("groq","","","")):
            with patch.object(SERVER,"call_llm",return_value=fake):
                result=SERVER.act(world(),"I climb the fire escape")
        self.assertEqual(result["state"]["scene"],"rooftop")
        self.assertIn("clock_marks",result["state"]["evidence"])
        self.assertEqual(result["options"][0],"Look for Jae")
    def test_invalid_world_and_chat_are_rejected(self):
        with self.assertRaisesRegex(ValueError,"Unsupported"):
            SERVER.act({"version":1},"Go")
        with self.assertRaisesRegex(ValueError,"known character"):
            SERVER.chat(world(),"unknown","Who are you?")
        with self.assertRaisesRegex(ValueError,"characters"):
            SERVER.chat(world(),"sori","")
    def test_input_size_and_event_limit(self):
        with self.assertRaises(ValueError):
            SERVER.act(world(),"x"*701)
        with self.assertRaises(ValueError):
            SERVER.chat(world(),"sori","x"*901)

class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.patch=patch.object(SERVER,"provider",return_value=("offline","","",""))
        cls.patch.start()
        cls.server=SERVER.ThreadingHTTPServer(("127.0.0.1",0),SERVER.Handler)
        cls.port=cls.server.server_port
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True)
        cls.thread.start()
    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=3)
        cls.patch.stop()
    def test_server_health_and_html(self):
        root=f"http://127.0.0.1:{self.port}"
        with request.urlopen(root+"/api/health",timeout=5) as response:
            payload=json.loads(response.read())
        self.assertEqual(payload["mode"],"offline")
        with request.urlopen(root+"/multiverse/",timeout=5) as response:
            page=response.read().decode()
        self.assertIn('id="action-form"',page)
        self.assertIn('id="chat-form"',page)
        self.assertIn('class="reader-duo"',page)
        self.assertIn('id="timeline"',page)
    def test_local_secrets_and_backend_are_not_public_assets(self):
        base=f"http://127.0.0.1:{self.port}"
        for target in ("/multiverse/.env","/multiverse/.env.example",
                       "/multiverse/server.py","/.git/config","/multiverse/README.md"):
            with self.assertRaises(error.HTTPError) as ctx:
                request.urlopen(base+target,timeout=5)
            self.assertEqual(ctx.exception.code,404,target)

    def test_action_and_chat_http_roundtrip(self):
        url=f"http://127.0.0.1:{self.port}"
        data=json.dumps({"world":world(),"text":"I ask for the silver key"}).encode()
        req=request.Request(url+"/api/act",data=data,
                             headers={"Content-Type":"application/json","Origin":url})
        with request.urlopen(req,timeout=5) as response:
            result=json.load(response)
        self.assertIn("silver key",result["state"]["inventory"])
        body=json.dumps({"world":result["world"],"character":"sori",
                         "text":"Do you trust Jae?"}).encode()
        req=request.Request(url+"/api/chat",data=body,
                             headers={"Content-Type":"application/json","Origin":url})
        with request.urlopen(req,timeout=5) as response:
            reply=json.load(response)
        self.assertEqual(reply["world"]["branches"][0]["events"][-1]["type"],"chat")
        self.assertIn("Sori",reply["reply"])

if __name__=="__main__":
    unittest.main()
