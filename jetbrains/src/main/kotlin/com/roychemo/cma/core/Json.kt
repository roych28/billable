package com.roychemo.cma.core

/**
 * A small JSON reader for the few files the plugin reads (status, ledger, transcripts, .claude.json). It keeps the
 * plugin free of a JSON library dependency, whose availability to plugins changes between IDE versions.
 *
 * Objects become [Map], arrays [List], numbers [Double], and the rest String, Boolean or null.
 */
object Json {
    class ParseException(message: String) : RuntimeException(message)

    fun parse(text: String): Any? {
        val r = Reader(text)
        r.ws()
        val v = r.value()
        r.ws()
        if (r.i != text.length) throw ParseException("Trailing characters at ${r.i}")
        return v
    }

    fun parseOrNull(text: String): Any? = try {
        parse(text)
    } catch (_: RuntimeException) {
        null
    }

    private class Reader(val s: String) {
        var i = 0

        fun ws() {
            while (i < s.length && s[i].let { it == ' ' || it == '\n' || it == '\r' || it == '\t' }) i++
        }

        fun value(): Any? {
            if (i >= s.length) throw ParseException("Unexpected end")
            return when (val c = s[i]) {
                '{' -> obj()
                '[' -> arr()
                '"' -> str()
                't' -> word("true", true)
                'f' -> word("false", false)
                'n' -> word("null", null)
                else -> if (c == '-' || c.isDigit()) num() else throw ParseException("Unexpected '$c' at $i")
            }
        }

        fun word(w: String, v: Any?): Any? {
            if (!s.startsWith(w, i)) throw ParseException("Expected $w at $i")
            i += w.length
            return v
        }

        fun obj(): Map<String, Any?> {
            val m = LinkedHashMap<String, Any?>()
            i++
            ws()
            if (s.getOrNull(i) == '}') {
                i++
                return m
            }
            while (true) {
                ws()
                if (s.getOrNull(i) != '"') throw ParseException("Expected a key at $i")
                val k = str()
                ws()
                if (s.getOrNull(i) != ':') throw ParseException("Expected ':' at $i")
                i++
                ws()
                m[k] = value()
                ws()
                when (s.getOrNull(i)) {
                    ',' -> i++
                    '}' -> {
                        i++
                        return m
                    }
                    else -> throw ParseException("Expected ',' or '}' at $i")
                }
            }
        }

        fun arr(): List<Any?> {
            val l = ArrayList<Any?>()
            i++
            ws()
            if (s.getOrNull(i) == ']') {
                i++
                return l
            }
            while (true) {
                ws()
                l.add(value())
                ws()
                when (s.getOrNull(i)) {
                    ',' -> i++
                    ']' -> {
                        i++
                        return l
                    }
                    else -> throw ParseException("Expected ',' or ']' at $i")
                }
            }
        }

        fun str(): String {
            val b = StringBuilder()
            i++
            while (true) {
                if (i >= s.length) throw ParseException("Unterminated string")
                val c = s[i++]
                when (c) {
                    '"' -> return b.toString()
                    '\\' -> {
                        if (i >= s.length) throw ParseException("Unterminated escape")
                        when (val e = s[i++]) {
                            '"', '\\', '/' -> b.append(e)
                            'b' -> b.append('\b')
                            'f' -> b.append('\u000C')
                            'n' -> b.append('\n')
                            'r' -> b.append('\r')
                            't' -> b.append('\t')
                            'u' -> {
                                if (i + 4 > s.length) throw ParseException("Bad unicode escape")
                                b.append(s.substring(i, i + 4).toInt(16).toChar())
                                i += 4
                            }
                            else -> throw ParseException("Bad escape \\$e")
                        }
                    }
                    else -> b.append(c)
                }
            }
        }

        fun num(): Double {
            val start = i
            if (s[i] == '-') i++
            while (i < s.length && (s[i].isDigit() || s[i] in ".eE+-")) i++
            return s.substring(start, i).toDoubleOrNull() ?: throw ParseException("Bad number at $start")
        }
    }
}

@Suppress("UNCHECKED_CAST")
internal fun Any?.obj(): Map<String, Any?>? = this as? Map<String, Any?>

internal fun Any?.field(name: String): Any? = obj()?.get(name)

internal fun Any?.str(name: String): String? = field(name) as? String

internal fun Any?.num(name: String): Double? = field(name) as? Double
