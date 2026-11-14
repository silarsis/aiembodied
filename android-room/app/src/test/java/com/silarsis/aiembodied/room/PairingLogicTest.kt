package com.silarsis.aiembodied.room

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingLogicTest {
    @Test
    fun hostsAreCheckedAndLowerCased() {
        assertEquals("bija", PairingLogic.normalizeHost(" Bija "))
        assertEquals("bija.tail1234.ts.net", PairingLogic.normalizeHost("bija.tail1234.ts.net"))
        assertEquals("100.64.0.7", PairingLogic.normalizeHost("100.64.0.7"))
        assertNull(PairingLogic.normalizeHost(""))
        assertNull(PairingLogic.normalizeHost("http://bija"))
        assertNull(PairingLogic.normalizeHost("bija:8791"))
        assertNull(PairingLogic.normalizeHost("bija/app"))
        assertNull(PairingLogic.normalizeHost("a..b"))
        assertNull(PairingLogic.normalizeHost("-bija"))
        assertNull(PairingLogic.normalizeHost("bija x"))
        assertNull(PairingLogic.normalizeHost(null))
    }

    @Test
    fun portDefaultsAndIsRangeChecked() {
        assertEquals(8791, PairingLogic.parsePort(""))
        assertEquals(8791, PairingLogic.parsePort(null))
        assertEquals(9000, PairingLogic.parsePort(" 9000 "))
        assertNull(PairingLogic.parsePort("0"))
        assertNull(PairingLogic.parsePort("70000"))
        assertNull(PairingLogic.parsePort("abc"))
    }

    @Test
    fun codeIsSixDigits() {
        assertEquals("123456", PairingLogic.normalizeCode("123 456"))
        assertNull(PairingLogic.normalizeCode("12345"))
        assertNull(PairingLogic.normalizeCode("1234567"))
        assertNull(PairingLogic.normalizeCode("12345a"))
        assertNull(PairingLogic.normalizeCode(null))
    }

    @Test
    fun theBodySaysPhone() {
        assertEquals(
            "{\"code\":\"123456\",\"deviceName\":\"Pixel 8\",\"placeName\":\"the phone\",\"kind\":\"phone\"}",
            PairingLogic.buildPairBody("123456", "Pixel 8", "", "ignored"),
        )
    }

    @Test
    fun theBodyFallsBackAndTruncatesAndEscapes() {
        val body = PairingLogic.buildPairBody("123456", "  ", "Kevin's \"den\"\n", "Model X")
        assertTrue(body.contains("\"deviceName\":\"Model X\""))
        assertTrue(body.contains("\"placeName\":\"Kevin's \\\"den\\\"\""))
        val long = PairingLogic.buildPairBody("123456", "a".repeat(100), "b", "m")
        assertTrue(long.contains("\"deviceName\":\"" + "a".repeat(60) + "\""))
    }

    @Test
    fun jsonStringEscapesControlCharacters() {
        assertEquals("\"a\\\\b\\tc\\u0001\"", PairingLogic.jsonString("a\\b\tc\u0001"))
    }

    @Test
    fun theAnswerIsRead() {
        val answer = PairingLogic.parsePairAnswer("{\"deviceId\":\"dev-1\",\"token\":\"abc_DEF-123\",\"placeId\":\"place-9\",\"protocol\":1}")
        assertEquals(PairAnswer("dev-1", "abc_DEF-123", "place-9"), answer)
        assertNull(PairingLogic.parsePairAnswer("{\"deviceId\":\"dev-1\"}"))
        assertNull(PairingLogic.parsePairAnswer("not json"))
        assertNull(PairingLogic.parsePairAnswer("{\"deviceId\":\"\",\"token\":\"t\",\"placeId\":\"p\"}"))
        // A value with an escape is not accepted (tokens never have one).
        assertNull(PairingLogic.parsePairAnswer("{\"deviceId\":\"a\\\"b\",\"token\":\"t\",\"placeId\":\"p\"}"))
    }

    @Test
    fun errorsAreInWords() {
        assertTrue(PairingLogic.errorMessage(401).contains("wrong or has expired"))
        assertTrue(PairingLogic.errorMessage(429).contains("Wait a minute"))
        assertEquals("bija answered 500.", PairingLogic.errorMessage(500))
    }

    @Test
    fun theShellGetsTheWebSocketAddressAndNothingWhenNotPaired() {
        assertEquals("{}", PairingLogic.shellPairingJson(null))
        val json = PairingLogic.shellPairingJson(Pairing("bija", 8791, "dev", "tok", "Pixel"))
        assertEquals("ws://bija:8791", PairingLogic.jsonStringField(json, "hubUrl"))
        assertEquals("dev", PairingLogic.jsonStringField(json, "deviceId"))
        assertEquals("tok", PairingLogic.jsonStringField(json, "token"))
        assertEquals("Pixel", PairingLogic.jsonStringField(json, "deviceName"))
    }
}
