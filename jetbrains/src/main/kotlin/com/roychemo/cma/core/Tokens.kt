package com.roychemo.cma.core

import java.io.File
import java.io.RandomAccessFile
import java.math.BigDecimal
import java.math.RoundingMode
import kotlin.math.floor

data class Tokens(val input: Long, val output: Long, val cacheRead: Long, val cacheWrite: Long) {
    val total get() = input + output + cacheRead + cacheWrite
}

/**
 * Token counts read from a session transcript (JSONL). Each assistant message is counted once, by its id, and a
 * transcript is read incrementally: a second call reads only what was appended since.
 */
class TranscriptReader {
    private class State {
        var offset = 0L
        var tail = ByteArray(0)
        val byMessage = LinkedHashMap<String, Map<String, Any?>>()
    }

    private val states = HashMap<String, State>()

    @Synchronized
    fun sessionTokens(file: String?): Tokens? {
        if (file.isNullOrEmpty()) return null
        val f = File(file)
        if (!f.isFile) return null
        val state = states.getOrPut(file) { State() }
        val size = f.length()
        if (size < state.offset) {
            state.offset = 0
            state.tail = ByteArray(0)
            state.byMessage.clear()
        }
        if (size > state.offset) {
            val buf = ByteArray((size - state.offset).toInt())
            RandomAccessFile(f, "r").use {
                it.seek(state.offset)
                it.readFully(buf)
            }
            state.offset = size
            val all = state.tail + buf
            var start = 0
            for (i in all.indices) {
                if (all[i] == '\n'.code.toByte()) {
                    line(String(all, start, i - start, Charsets.UTF_8), state)
                    start = i + 1
                }
            }
            state.tail = all.copyOfRange(start, all.size)
        }
        var t = Tokens(0, 0, 0, 0)
        for (u in state.byMessage.values) {
            fun n(k: String) = (u[k] as? Double)?.toLong() ?: 0L
            t = Tokens(
                t.input + n("input_tokens"),
                t.output + n("output_tokens"),
                t.cacheRead + n("cache_read_input_tokens"),
                t.cacheWrite + n("cache_creation_input_tokens"),
            )
        }
        return t
    }

    private fun line(line: String, state: State) {
        if (!line.contains("\"usage\"")) return
        val r = Json.parseOrNull(line).obj() ?: return
        if (r["type"] != "assistant") return
        val message = r["message"].obj() ?: return
        val usage = message["usage"].obj() ?: return
        val key = (message["id"] ?: r["requestId"] ?: r["uuid"])?.toString() ?: "undefined"
        state.byMessage[key] = usage
    }
}

/** 1234 -> 1K, 2_500_000 -> 2.5M, as the VS Code extension shows them. */
fun short(n: Long): String = when {
    n >= 1_000_000 -> "${toFixed(n / 1_000_000.0, 1)}M"
    n >= 1_000 -> "${floor(n / 1_000.0 + 0.5).toLong()}K"
    else -> n.toString()
}

/** JavaScript's Number.prototype.toFixed: rounds the exact binary value half up. */
fun toFixed(v: Double, digits: Int): String = BigDecimal(v).setScale(digits, RoundingMode.HALF_UP).toPlainString()

fun money(usd: Double): String = "$" + toFixed(usd, 2)

/** A number the way JavaScript prints it in a template string: 45 rather than 45.0. */
fun jsNumber(v: Double): String = if (v == floor(v) && !v.isInfinite() && kotlin.math.abs(v) < 1e15) v.toLong().toString() else v.toString()
