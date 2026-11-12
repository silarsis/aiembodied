#!/usr/bin/env python3
"""Deterministic training-data generator for the Laya floor-routing classifier.

Rows are composed from a scene, an addressing frame (which fixes the labels by
construction), content (what Kevin says) and surface noise.

    python floor_data.py --out DIR [--n 8000] [--seed 0] [--exclude FILE.jsonl]
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import floor_banks as B  # noqa: E402
from floor_prompt import build_questions, build_state, option_key  # noqa: E402

Q_MARK = "¿"  # sentinel: this utterance is a question, end with "?"


def norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


# ---------------------------------------------------------------- banks

class Bank:
    def __init__(self, split: str):
        self.split = split
        self.imp = _part(B.IMP, split)
        self.q = _part(B.Q, split)
        self.st = _part(B.ST, split)
        self.g_imp = _part(B.G_IMP, split)
        self.g_q = _part(B.G_Q, split)
        self.g_st = _part(B.G_ST, split)
        self.topics = _part(B.TOPICS, split)
        self.relay_q = _part(B.RELAY_Q, split)
        self.relay_msg = _part(B.RELAY_MSG, split)
        self.people_names = _part(B.PEOPLE_NAMES, split)
        self.people_rel = _part(B.PEOPLE_REL, split)
        self.relay_wh = [q for q in self.relay_q if q.split()[0] in ("what", "where", "when", "how", "who", "why")]
        self.msg_clause = [m for m in self.relay_msg if not m.startswith("to ")]

    def phrases(self) -> list[str]:
        out = []
        for lst in (self.imp, self.q, self.st, self.g_imp, self.g_q, self.g_st, self.topics,
                    self.relay_q, self.relay_msg):
            out.extend(lst)
        return out


def _part(items: list[str], split: str) -> list[str]:
    seen, uniq = set(), []
    for it in items:
        k = norm(it)
        if k not in seen:
            seen.add(k)
            uniq.append(it)
    order = list(uniq)
    random.Random(12345).shuffle(order)
    val = [x for i, x in enumerate(order) if i % 10 == 0]
    train = [x for i, x in enumerate(order) if i % 10 != 0]
    return sorted(val if split == "val" else train)


_BANKS: dict = {}


def get_bank(split: str) -> Bank:
    if split not in _BANKS:
        _BANKS[split] = Bank(split)
    return _BANKS[split]


# ---------------------------------------------------------------- helpers

GERUNDS = {w: g for w, g in (x.split(":") for x in """turn:turning set:setting remind:reminding add:adding put:putting
cancel:cancelling tell:telling read:reading give:giving look:looking search:searching find:finding check:checking
convert:converting translate:translating spell:spelling write:writing help:helping explain:explaining show:showing
remember:remembering forget:forgetting switch:switching dim:dimming make:making open:opening close:closing play:playing
pause:pausing skip:skipping stop:stopping sit:sitting come:coming walk:walking wave:waving do:doing dance:dancing
stand:standing take:taking count:counting say:saying sing:singing hum:humming speak:speaking summarise:summarising
pick:picking flip:flipping roll:rolling quiz:quizzing teach:teaching recommend:recommending suggest:suggesting
wake:waking lock:locking cheer:cheering keep:keeping pretend:pretending talk:talking start:starting time:timing
be:being jump:jumping stretch:stretching have:having let:letting spin:spinning hum:humming ask:asking chat:chatting
strike:striking catch:catching get:getting see:seeing go:going""".split())}


def gerund(inner: str):
    words = inner.split()
    if len(words) < 2 or words[1] == "and" or words[0] not in GERUNDS:
        return None
    return GERUNDS[words[0]] + " " + " ".join(words[1:])


FILLERS = ["um", "uh", "like", "so", "right"]
KINDS_ALL = ("imp", "q", "st")


class Ctx:
    def __init__(self, rng, bank, scene, last):
        self.rng = rng
        self.bank = bank
        self.scene = scene
        self.host = scene[0]
        self.last = last
        self.recent: list = []

    # names
    def others(self, *excl):
        return [n for n in self.scene if n not in excl]

    def name(self, nm: str) -> str:
        al = B.ALIASES.get(nm)
        if al and self.rng.random() < 0.06:
            return self.rng.choice(al)
        return nm

    def fmt(self, tpl: str, **kw) -> str:
        if self.rng.random() < 0.10:
            tpl = re.sub(r"^((?:(?:hey|ok|okay|oi|hi|yo|right|so) )?\{[A-Z]\}),", r"\1", tpl)

        def rep(m):
            k = m.group(1)
            if len(k) == 1 and k.isupper():
                return self.name(kw[k]) if kw[k] in self.scene else kw[k]
            return kw[k]
        return re.sub(r"\{(\w+)\}", rep, tpl)

    def pick(self, lst):
        return self.rng.choice(lst)

    # content
    def polite(self, inner: str, plain: float = 0.45) -> str:
        r = self.rng
        if r.random() < plain:
            return inner
        opts = [("please {x}", 8), ("{x} please", 8), ("can you {x}" + Q_MARK, 12), ("could you {x}" + Q_MARK, 10),
                ("would you mind {g}" + Q_MARK, 5), ("I'd like you to {x}", 4), ("why don't you {x}" + Q_MARK, 3),
                ("I want you to {x}", 2), ("I need you to {x}", 3), ("could you possibly {x}" + Q_MARK, 2)]
        g = gerund(inner)
        if g is None:
            opts = [o for o in opts if "{g}" not in o[0]]
        pat = r.choices([o[0] for o in opts], [o[1] for o in opts])[0]
        return pat.format(x=inner, g=g)

    def req(self, kinds=KINDS_ALL, wrap=True, group=False) -> str:
        r, b = self.rng, self.bank
        weights = {"imp": 45, "q": 40, "st": 15}
        kind = r.choices(list(kinds), [weights[k] for k in kinds])[0]
        if group and r.random() < 0.5:
            lst = {"imp": b.g_imp, "q": b.g_q, "st": b.g_st}[kind]
        else:
            lst = {"imp": b.imp, "q": b.q, "st": b.st}[kind]
        txt = r.choice(lst)
        if kind == "q":
            return txt + Q_MARK
        if kind == "imp" and wrap:
            return self.polite(txt, 0.5)
        return txt

    def q_only(self):
        return self.req(("q",))

    def imp_only(self, wrap=True):
        return self.req(("imp",), wrap)

    # noise
    def finish(self, text: str) -> str:
        r = self.rng
        text = re.sub(r"\s+", " ", text).strip()
        if r.random() < 0.15:
            toks = text.split(" ")
            cands = [0] + [i + 1 for i, t in enumerate(toks[:-1]) if t.endswith(",")]
            pos = r.choice(cands)
            f = r.choice(FILLERS)
            if pos > 0 and r.random() < 0.4:
                f += ","
            toks.insert(pos, f)
            text = " ".join(toks)
        is_q = Q_MARK in text
        text = text.replace(Q_MARK, "")
        if r.random() < 0.35:
            text = text.lower()
            text = re.sub(r"[,.?!;:]", "", text)
            if r.random() < 0.25:
                text = text.replace("'", "")
            return re.sub(r"\s+", " ", text).strip()
        text = text[0].upper() + text[1:]
        text = re.sub(r"\s+,", ",", text)
        if text[-1] not in ".?!":
            text += "?" if is_q else "."
        return text


# ---------------------------------------------------------------- frames
# each frame: f(c) -> (text, addressed, wants, other) or None to reject

VOC = [
    ("{A}, {x}", 5, KINDS_ALL), ("hey {A}, {x}", 2, KINDS_ALL), ("hey {A} {x}", 2, KINDS_ALL),
    ("{x}, {A}", 3, KINDS_ALL), ("{A} {x}", 2, KINDS_ALL), ("ok {A}, {x}", 1, KINDS_ALL),
    ("okay {A}, {x}", 1, KINDS_ALL), ("oi {A}, {x}", 1, KINDS_ALL), ("hi {A}, {x}", 1, KINDS_ALL),
    ("yo {A}, {x}", 1, KINDS_ALL), ("right {A}, {x}", 1, KINDS_ALL), ("so {A}, {x}", 1, KINDS_ALL),
    ("excuse me {A}, {x}", 1, ("imp", "q")), ("{A} mate, {x}", 1, KINDS_ALL),
    ("{A}, {x}, thanks", 1, ("imp", "q")), ("{A}, quick one, {x}", 1, ("q",)),
    ("{A}, are you there, {x}", 1, KINDS_ALL), ("hang on {A}, {x}", 1, ("imp", "q")),
    ("{A}, hey, {x}", 1, KINDS_ALL),
]
NONAME = [
    ("{x}", 6, KINDS_ALL, True), ("right, {x}", 1, KINDS_ALL, True), ("okay, {x}", 1, KINDS_ALL, True),
    ("so, {x}", 1, KINDS_ALL, True), ("actually, {x}", 1, KINDS_ALL, True),
    ("sorry, {x}", 1, ("imp", "q"), True), ("quick question, {x}", 1, ("q",), False),
    ("I was wondering, {x}", 1, ("q",), False), ("one more thing, {x}", 1, ("imp", "q"), True),
    ("{x} please", 1, ("imp",), False), ("hang on, {x}", 1, ("imp", "q"), True),
    ("oh and {x}", 1, ("imp", "q"), True), ("also, {x}", 1, ("imp", "q"), True),
    ("while you're at it, {x}", 1, ("imp",), True), ("just {x}", 1, ("imp",), False),
    ("I need you to {x}", 1, ("imp",), False), ("go on then, {x}", 1, ("imp",), True),
]


def voc_wrap(c, A, make_x, rand_kinds=None):
    """Wrap an inner utterance in a random vocative form. make_x(kinds) -> str."""
    forms = c.rng.choices(VOC, [f[1] for f in VOC])[0]
    tpl, _, kinds = forms
    return c.fmt(tpl, A=A, x=make_x(kinds))


def noname_wrap(c):
    f = c.rng.choices(NONAME, [f[1] for f in NONAME])[0]
    tpl, _, kinds, wrap = f
    return c.fmt(tpl, x=c.req(kinds, wrap))


def f_vocative_answer(c):
    A = c.pick(c.scene)
    return voc_wrap(c, A, lambda k: c.req(k)), A.lower(), "answer", "none"


def f_no_name(c):
    return noname_wrap(c), "unclear", "answer", "none"


def f_single(c):
    A = c.scene[0]
    if c.rng.random() < 0.5:
        return voc_wrap(c, A, lambda k: c.req(k)), A.lower(), "answer", "none"
    return noname_wrap(c), "unclear", "answer", "none"


GROUPS = {
    2: [("you two", True), ("both of you", True), ("the two of you", True)],
    3: [("you three", True), ("all three of you", True)],
    4: [("you four", True), ("all four of you", True)],
}
GROUPS_ANY = [("everyone", True), ("all of you", True), ("guys", True), ("everybody", True), ("you lot", True),
              ("hello everybody", False), ("hi everyone", False), ("morning all", False),
              ("hey guys", False), ("listen everyone", False)]


def f_group(c):
    n = len(c.scene)
    if n < 2:
        return None
    g, trail = c.pick(GROUPS.get(n, []) + GROUPS_ANY * 2)
    forms = ["{g}, {x}", "hey {g}, {x}", "okay {g}, {x}", "right {g}, {x}", "{g} {x}", "{x}, {g}"]
    if not trail:
        forms = ["{g}, {x}", "{g} {x}"]
    tpl = c.pick(forms)
    if tpl.startswith("hey ") and g.startswith(("hey", "hello", "hi")):
        tpl = "{g}, {x}"
    return c.fmt(tpl, g=g, x=c.req(group=True)), "everyone", "answer", "none"


CONV_VERBS = ["talk to", "chat with", "have a word with", "go and talk to", "strike up a conversation with",
              "say something to", "catch up with", "have a chat with", "go and chat to", "speak to",
              "go and have a word with", "get chatting with"]
CONV_TAIL = [" for a bit", " for a while", " for a few minutes", " while I make a cuppa", " while I'm out"]


def converse_inner(c, Bn):
    r = c.rng
    s = c.pick(CONV_VERBS) + " " + Bn
    if r.random() < 0.45:
        s += " about " + c.pick(c.bank.topics)
    if r.random() < 0.25:
        s += c.pick(CONV_TAIL)
    return s


def f_converse_voc(c):
    if len(c.scene) < 2:
        return None
    A = c.pick(c.scene)
    Bn = c.pick(c.others(A))
    x = lambda k: c.polite(converse_inner(c, "{B}"), 0.4)
    t = voc_wrap(c, A, x)
    return c.fmt(t, B=Bn), A.lower(), "converse", Bn.lower()


def f_converse_novoc(c):
    if len(c.scene) < 2:
        return None
    Bn = c.pick(c.scene)
    t = c.polite(converse_inner(c, "{B}"), 0.35)
    return c.fmt(t, B=Bn), "unclear", "converse", Bn.lower()


def relay_inner(c, three_plus=False):
    """Returns a template with {B} and no vocative."""
    r, b = c.rng, c.bank
    q, qw = r.choice(b.relay_q), r.choice(b.relay_wh)
    m, mc, tp = r.choice(b.relay_msg), r.choice(b.msg_clause), r.choice(b.topics)
    opts = [
        (3, True, f"ask {{B}} {q}"), (2, True, f"go and ask {{B}} {q}"), (2, True, f"find out from {{B}} {q}"),
        (2, True, f"check with {{B}} {q}"), (1, True, f"see if {{B}} knows {qw}"), (4, True, f"tell {{B}} {m}"),
        (2, True, f"tell {{B}} that {mc}"), (2, True, f"let {{B}} know {mc}"), (2, True, f"go and tell {{B}} {m}"),
        (1, True, f"pass it on to {{B}} that {mc}"), (2, True, f"ask {{B}} {q} and let me know"),
        (1, True, f"ask {{B}} {q} and tell me what they say"),
        (1, True, f"get {{B}}'s opinion on {tp} and tell me"), (1, True, f"find out what {{B}} thinks about {tp}"),
        (1, True, f"just ask {{B}} {q}"), (1, True, f"quickly ask {{B}} {q}"),
        (1, True, f"go and find out from {{B}} {q} and report back"),
        (1, False, f"when you get a second see if {{B}} knows {qw} and let me know"),
        (1, False, f"when you get a chance, ask {{B}} {q}"),
        (1, False, f"if you see {{B}}, tell them {mc}" if False else f"ask {{B}} {q} when you get a moment"),
    ]
    w, ok, t = r.choices(opts, [o[0] for o in opts])[0]
    return c.polite(t, 0.4) if ok else t


def f_relay_voc(c):
    if len(c.scene) < 2:
        return None
    A = c.pick(c.scene)
    Bn = c.pick(c.others(A))
    t = voc_wrap(c, A, lambda k: relay_inner(c))
    return c.fmt(t, B=Bn), A.lower(), "relay", Bn.lower()


def f_relay_novoc(c):
    if len(c.scene) < 2:
        return None
    Bn = c.pick(c.scene)
    r = c.rng
    if len(c.scene) >= 3 and r.random() < 0.25:
        q, m = r.choice(c.bank.relay_q), r.choice(c.bank.relay_msg)
        t = r.choice([f"could one of you find out from {{B}} {q}", f"can one of you ask {{B}} {q}",
                      f"one of you go and tell {{B}} {m}", f"could one of you ask {{B}} {q} for me"])
        t = t + (Q_MARK if t.startswith(("could", "can")) else "")
    else:
        t = relay_inner(c)
    return c.fmt(t, B=Bn), "unclear", "relay", Bn.lower()


MENTION_VOC = [
    "{A}, what do you think of {B}?", "{A}, is {B} always this quiet?", "{A}, do you like {B}'s voice?",
    "what's {B}'s favourite colour, {A}?", "{A}, how long have you known {B}?",
    "{A}, is {B} alright, they seem a bit down?", "{A}, does {B} ever get tired?",
    "{A}, how do you and {B} get along?", "{A}, do you think {B} is happy in here?", "{A}, what does {B} do all day?",
    "{A}, I think {B} likes you", "so {A}, is {B} any good at chess?", "{A}, what's {B}'s deal?",
    "do you reckon {B} is funny, {A}?", "how well do you know {B}, {A}?", "{A}, is {B} new here?",
    "{A}, has {B} said anything interesting today?", "hey {A}, what's {B} like?",
    "{A}, do you ever argue with {B}?", "{A}, who's taller, you or {B}?",
]
MENTION_NO = [
    "tell me about {B}", "what's {B} like?", "who is {B} anyway?", "has {B} been behaving?",
    "what's {B}'s favourite song?", "is {B} always this quiet?", "what's {B} up to?", "I wonder if {B} likes music",
    "do you know much about {B}?", "how does {B} feel about the room?",
]


def f_mention(c):
    if len(c.scene) < 2:
        return None
    A = c.pick(c.scene)
    Bn = c.pick(c.others(A))
    if c.rng.random() < 0.75:
        return c.fmt(c.pick(MENTION_VOC), A=A, B=Bn), A.lower(), "answer", "none"
    return c.fmt(c.pick(MENTION_NO), B=Bn), "unclear", "answer", "none"


HUMAN_VOC = [
    "{A}, remind me to call {P}", "{A}, remind me to ring {P} tomorrow", "{A}, add a reminder for {P}'s birthday",
    "{A}, text {P} that I'm on my way", "{A}, send {P} a message saying I'll be late",
    "{A}, what time is {P} coming over?", "{A}, did {P} email me today?", "{A}, is {P} free on Saturday?",
    "{A}, I'm meeting {P} for lunch, how's the weather looking?", "{A}, put {P}'s birthday in the calendar",
    "{A}, {P} is coming for dinner so can you play something nice?", "{A}, tell {P} I'm running late",
    "hey {A}, can you call {P}?", "{A}, find {P}'s number for me",
]
HUMAN_NO = [
    "remind me to ring {P} tomorrow", "tell {P} I'm running late", "text {P} that I'm on my way",
    "send {P} a message saying I'll be late", "I'm meeting {P} for lunch", "can you call {P}?",
    "did {P} email me today?", "what time is {P} coming over?", "{P} is coming over this arvo",
    "remind me to buy a present for {P}", "I need to speak to {P} about the rent",
]
HUMAN_NAMED_ONLY = [
    "my friend {P} is coming over this arvo", "{P} is coming round for dinner tonight", "I'm having a coffee with {P} later",
]
SAMENAME_VOC = [
    "{A}, remind me to ring my cousin {X} tonight", "{A}, my friend {X} from work is coming over later",
    "{A}, I had lunch with a guy called {X} today", "{A}, my neighbour {X} is visiting next week",
    "{A}, I met a woman called {X} at the shops",
]
SAMENAME_NO = [
    "my friend {X} from work is coming over later", "I had lunch with a guy called {X}",
    "my cousin {X} is visiting next week", "I met a woman called {X} at the shops",
    "remind me to ring my mate {X} tonight", "my uncle {X} is coming for Christmas",
]


def f_human(c):
    r = c.rng
    if r.random() < 0.22:
        X = c.pick(c.scene)
        voc = r.random() < 0.5 and len(c.scene) >= 2
        if voc:
            A = c.pick(c.others(X))
            return c.fmt(c.pick(SAMENAME_VOC), A=A, X=X), A.lower(), "answer", "none"
        return c.fmt(c.pick(SAMENAME_NO), X=X), "unclear", "answer", "none"
    named = c.bank.people_names
    rel = c.bank.people_rel
    if r.random() < 0.45:
        P = c.pick(named)
        pool_voc, pool_no = HUMAN_VOC, HUMAN_NO + HUMAN_NAMED_ONLY
    else:
        P = c.pick(rel)
        pool_voc, pool_no = HUMAN_VOC, HUMAN_NO
    if r.random() < 0.55:
        A = c.pick(c.scene)
        t = c.fmt(c.pick(pool_voc), A=A, P=P)
        return t, A.lower(), "answer", "none"
    return c.fmt(c.pick(pool_no), P=P), "unclear", "answer", "none"


EXCL = [
    "not you, {A}. {B}, {x}", "{A}, quiet for a second. {B}, {x}", "no not {A}, I meant {B}. {x}",
    "sorry {A}, I wasn't talking to you. {B}, {x}", "{A} hold on a sec. {B}, {x}", "not {A}, {B}, {x}",
    "{A} no, you stay out of it. {B}, {x}", "oh not you {A}, I was asking {B}. {x}", "wait {A}, I meant {B}. {x}",
    "{A} I'm talking to {B} right now. {B}, {x}", "{B} not {A}, {x}", "{A}, hang on. {B}, {x}",
    "no {A}, not you. {B}, {x}",
]


def f_exclude(c):
    if len(c.scene) < 2:
        return None
    A = c.pick(c.scene)
    Bn = c.pick(c.others(A))
    t = c.pick(EXCL)
    return c.fmt(t, A=A, B=Bn, x=c.req()), Bn.lower(), "answer", "none"


DISM_ANY = [
    "{A}, forget {B} for a second, {x}", "{A}, ignore {B}, {x}", "{A}, never mind {B}, {x}",
    "{A}, don't listen to {B}, {x}", "{A}, leave {B} out of this, {x}", "{A}, this one's for you, not {B}. {x}",
]
DISM_Q = ["{A}, I'm not asking {B}, I'm asking you: {x}", "{A}, I'm asking you, not {B}: {x}",
          "{A}, I want you to answer, not {B}: {x}"]
DISM_IMP = ["{A}, I don't want to hear from {B} right now, just {x}", "{A}, you do it, not {B}: {x}",
            "{A}, I'm not asking {B}, I'm asking you to {x}"]


def f_dismiss(c):
    if len(c.scene) < 2:
        return None
    A = c.pick(c.scene)
    Bn = c.pick(c.others(A))
    r = c.rng
    k = r.random()
    if k < 0.4:
        t, x = c.pick(DISM_ANY), c.req(("imp", "q"))
    elif k < 0.7:
        t, x = c.pick(DISM_Q), c.req(("q",))
    else:
        t = c.pick(DISM_IMP)
        x = c.imp_only(wrap=False)
    return c.fmt(t, A=A, B=Bn, x=x), A.lower(), "answer", "none"


ANYBUT = [
    "could somebody who isn't {A} answer this: {x}", "someone other than {A}, {x}", "anyone but {A}, {x}",
    "I'd like someone other than {A} to answer this one: {x}", "somebody who isn't {A}, {x}",
    "can anyone except {A} answer this: {x}", "let someone else take this one, not {A}. {x}",
    "can someone who's not {A} tell me this, {x}",
]


def f_anybut(c):
    n = len(c.scene)
    if n < 2:
        return None
    cands = [a for a in c.scene if a != c.last and not (c.last is None and a == c.host)] if n >= 3 else list(c.scene)
    if not cands:
        return None
    A = c.pick(cands)
    t = c.fmt(c.pick(ANYBUT), A=A, x=c.q_only())
    if n == 2:
        return t, c.others(A)[0].lower(), "answer", "none"
    return t, "unclear", "answer", "none"


STOP = [
    "{A}, stop talking to {B} and talk to me", "{A}, that's enough chatting with {B}, {x}",
    "{A}, leave {B} alone and listen", "{A}, stop chatting with {B} and come here",
    "{A}, you've talked to {B} enough, {x}", "{A}, leave {B} alone for a minute, I need you",
    "{A}, I need you to stop talking to {B}", "{A}, finish up with {B} and come and talk to me",
    "{A}, that's enough, come back to me, {x}", "{A}, break it up with {B}, {x}", "okay {A}, enough with {B}, {x}",
    "{A}, say goodbye to {B} and listen to me",
]


def f_stop(c):
    if len(c.scene) < 2:
        return None
    A = c.pick(c.scene)
    Bn = c.pick(c.others(A))
    return c.fmt(c.pick(STOP), A=A, B=Bn, x=c.req()), A.lower(), "answer", "none"


WANT = [
    "I want to talk to {B}", "{B}, talk to me", "let me speak to {B}", "can I have a word with {B}?", "put {B} on",
    "is {B} there? I'd like a word", "I'd like to speak to {B} please", "where's {B}? I want to chat",
    "{B}, come and talk to me", "{B}, I want to talk to you", "can I talk to {B}?", "I need a word with {B}",
    "hand me over to {B}", "{B}, have you got a minute?", "I'd like to chat to {B} for a bit", "right, {B}, over to you",
]


def f_want(c):
    if len(c.scene) < 2:
        return None
    Bn = c.pick(c.scene)
    return c.fmt(c.pick(WANT), B=Bn), Bn.lower(), "answer", "none"


ASIDE = [
    "I was telling {B} earlier about {t}. Anyway {A}, {x}", "{B} said something funny yesterday. {A}, {x}",
    "{B} and I were chatting earlier. Anyway, {A}, {x}", "I was just talking to {B} about {t}, anyway {A} {x}",
    "{B} was telling me about {t} earlier. Right, {A}, {x}", "so {B} told me a funny story earlier. {A}, {x}",
    "I had a good chat with {B} this morning. {A}, {x}", "I asked {B} about {t} earlier. Anyway, {A}, {x}",
    "{B} was in a good mood earlier. Anyway, {A}, {x}",
]


def f_aside(c):
    if len(c.scene) < 2:
        return None
    A = c.pick(c.scene)
    Bn = c.pick(c.others(A))
    return c.fmt(c.pick(ASIDE), A=A, B=Bn, t=c.pick(c.bank.topics), x=c.req()), A.lower(), "answer", "none"


DISCUSS = [
    "I'd love to hear the two of you discuss {t}. {A}, you start", "you two debate {t}, {A} goes first",
    "how about the pair of you chat about {t}? {A}, you kick us off", "I want you two to argue about {t}. {A}, go ahead and start",
    "let's hear you two talk about {t}. {A} first", "{A}, start us off, I want to hear you and {B} discuss {t}",
    "I'd like you both to talk about {t}, and {A}, you go first",
]


def f_discuss(c):
    if len(c.scene) != 2:
        return None
    A = c.pick(c.scene)
    Bn = c.others(A)[0]
    return c.fmt(c.pick(DISCUSS), A=A, B=Bn, t=c.pick(c.bank.topics)), A.lower(), "converse", Bn.lower()


def f_chain(c):
    if len(c.scene) < 3:
        return None
    A = c.pick(c.scene)
    Bn, Cn = c.rng.sample(c.others(A), 2)
    t = c.pick([
        "{A}, tell {B} to talk to {C}", "{A}, tell {B} they should go and chat with {C}", "{A}, tell {B} that {C} wants a word",
        "{A}, ask {B} what {C} thinks about {t}", "{A}, ask {B} whether {C} is coming", "{A}, ask {B} if {C} wants some tea",
        "{A}, find out from {B} what {C} is cooking", "{A}, ask {B} how {C} is feeling", "{A}, let {B} know {C} is looking for them",
        "{A}, ask {B} where {C} went",
    ])
    return c.fmt(t, A=A, B=Bn, C=Cn, t=c.pick(c.bank.topics)), A.lower(), "relay", Bn.lower()


PRON_KEV = [
    "ask {p} yourself", "go and ask {p} then", "tell {p} I said thanks", "why don't you ask {p}", "just ask {p}",
    "can you ask {p} for me", "tell {p} I said hi", "check with {p}", "ask {p} about it", "go on then, ask {p}",
    "tell {p} thanks from me", "pass that on to {p}", "go and tell {p} then",
]


def f_pronoun(c):
    if len(c.scene) < 2:
        return None
    r = c.rng
    S = c.pick(c.scene)
    Bn = c.pick(c.others(S))
    line = c.fmt(c.pick(B.RECENT_ABOUT_B), B=Bn)
    rec = []
    if r.random() < 0.5:
        rec.append(("Kevin", r.choice(["where did I leave my charger", "what time is the match on", "does anyone know the wifi code",
                                       "who turned the heating on", "what's the recipe for the soup"])))
    rec.append((S, line))
    c.recent = rec
    if r.random() < 0.7:
        c.last = S
    p = c.pick(["her", "him", "them"])
    return c.pick(PRON_KEV).format(p=p), "unclear", "relay", Bn.lower()


# name -> (weight, min_n, max_n, fn)
FRAMES = {
    "vocative-answer": (16, 2, 4, f_vocative_answer), "no-name": (14, 2, 4, f_no_name), "group": (8, 2, 4, f_group),
    "converse-vocative": (11, 2, 4, f_converse_voc), "converse-no-vocative": (6, 2, 4, f_converse_novoc),
    "relay-vocative": (11, 2, 4, f_relay_voc), "relay-no-vocative": (5, 2, 4, f_relay_novoc),
    "mention-only": (8, 2, 4, f_mention), "human-third-party": (4, 1, 4, f_human),
    "exclude-then-address": (3, 2, 4, f_exclude), "address-with-dismissal": (4, 2, 4, f_dismiss),
    "anyone-but": (1.5, 2, 4, f_anybut), "stop-and-return": (2, 2, 4, f_stop), "kevin-wants-to-talk-to": (2.5, 2, 4, f_want),
    "aside-then-address": (2, 2, 4, f_aside), "discuss-you-start": (1.8, 2, 2, f_discuss),
    "relay-chain": (2.5, 3, 4, f_chain), "pronoun-follow-up": (1.5, 2, 4, f_pronoun),
    "single-avatar": (80, 1, 1, f_single),
}
# human-third-party is the only other frame allowed in one-avatar rooms
FRAME_N1 = {"single-avatar": 80, "human-third-party": 20}


def pick_scene(r):
    n = r.choices([1, 2, 3, 4], [5, 55, 28, 12])[0]
    flags = [nm for nm in ("Echo", "Sage") if r.random() < 0.30]
    r.shuffle(flags)
    flags = flags[:n]
    pool = [x for x in B.NAMES if x not in ("Echo", "Sage")]
    scene = flags + r.sample(pool, n - len(flags))
    r.shuffle(scene)
    return scene


def make_ctx(r, bank):
    scene = pick_scene(r)
    last = None if r.random() < 0.45 else r.choice(scene)
    c = Ctx(r, bank, scene, last)
    if r.random() >= 0.70:
        k = r.randint(1, 3)
        who = r.choice(["k", "a"])
        rec = []
        for _ in range(k):
            if who == "k":
                rec.append(("Kevin", r.choice(B.RECENT_KEVIN)))
            else:
                rec.append((r.choice(scene), r.choice(B.RECENT_AVATAR)))
            who = "a" if who == "k" else "k"
        c.recent = rec
    return c


def pick_frame(r, n):
    if n == 1:
        names = list(FRAME_N1)
        return r.choices(names, [FRAME_N1[x] for x in names])[0]
    names, w = [], []
    for name, (wt, lo, hi, _) in FRAMES.items():
        if name == "single-avatar" or not (lo <= n <= hi):
            continue
        names.append(name)
        w.append(wt * (1.0 if name != "relay-chain" else 1.0))
    return r.choices(names, w)[0]


def generate_split(n_rows: int, seed, split: str, exclude=frozenset()):
    r = random.Random(f"{seed}:{split}")
    bank = get_bank(split)
    rows, seen = [], set()
    attempts = 0
    while len(rows) < n_rows:
        attempts += 1
        if attempts > n_rows * 50 + 1000:
            raise RuntimeError("could not generate enough unique rows")
        c = make_ctx(r, bank)
        frame = pick_frame(r, len(c.scene))
        out = FRAMES[frame][3](c)
        if out is None:
            continue
        text, addressed, wants, other = out
        text = c.finish(text)
        if not text or norm(text) in exclude:
            continue
        keys = [option_key(x) for x in c.scene]
        if addressed not in keys + ["everyone", "unclear"] or (other != "none" and other not in keys):
            raise AssertionError((frame, text, addressed, other))
        if wants in ("converse", "relay") and (other == "none" or other == addressed):
            raise AssertionError((frame, text))
        state = build_state(c.scene, c.host, c.last, c.recent, text)
        if state in seen:
            continue
        seen.add(state)
        rows.append({
            "state": state,
            "questions": build_questions(c.scene),
            "expected": {"addressed": addressed, "wants": wants, "other": other},
            "meta": {"frame": frame, "scene": c.scene, "host": c.host, "last": c.last, "text": text},
        })
    return rows


def load_exclude(path):
    out = set()
    if not path:
        return out
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            t = (row.get("meta") or {}).get("text") or row.get("text")
            if t:
                out.add(norm(t))
    return out


def summarize(rows, title):
    print(f"\n== {title}: {len(rows)} rows ==")
    print("per frame:")
    for k, v in sorted(Counter(r["meta"]["frame"] for r in rows).items(), key=lambda kv: -kv[1]):
        print(f"  {k:26s} {v:6d}  {100 * v / len(rows):5.1f}%")

    def cat_addr(e, r):
        a = e["addressed"]
        return a if a in ("everyone", "unclear") else "avatar"
    print("addressed:", dict(Counter(cat_addr(r["expected"], r) for r in rows)))
    print("wants:", dict(Counter(r["expected"]["wants"] for r in rows)))
    print("other:", dict(Counter("none" if r["expected"]["other"] == "none" else "avatar" for r in rows)))
    print("scene size:", dict(sorted(Counter(len(r["meta"]["scene"]) for r in rows).items())))


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--n", type=int, default=8000)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--exclude")
    a = ap.parse_args(argv)
    excl = load_exclude(a.exclude)
    n_val = max(1, a.n // 10)
    train = generate_split(a.n - n_val, a.seed, "train", excl)
    val = generate_split(n_val, a.seed, "val", excl)
    os.makedirs(a.out, exist_ok=True)
    for name, rows in (("train.jsonl", train), ("val.jsonl", val)):
        with open(os.path.join(a.out, name), "w", encoding="utf-8") as f:
            for row in rows:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
    summarize(train, "train")
    summarize(val, "val")
    summarize(train + val, "all")
    if excl:
        print(f"\nexcluded texts loaded: {len(excl)}")


if __name__ == "__main__":
    main()
