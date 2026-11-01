package com.silarsis.aiembodied.companion

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.NoiseSuppressor
import android.util.Log

/**
 * Records 16 kHz mono 16-bit PCM and hands it over in ~100 ms chunks. The page decides when
 * speech starts and ends; this only runs while the page is listening.
 */
class MicRecorder(
    private val onChunk: (ByteArray, Int) -> Unit,
    private val onError: (String) -> Unit,
) {
    @Volatile
    private var running = false
    private var thread: Thread? = null

    val isRunning: Boolean
        get() = running

    @SuppressLint("MissingPermission") // MainActivity checks RECORD_AUDIO before starting.
    @Synchronized
    fun start() {
        if (running) return
        running = true
        thread = Thread({ record() }, "companion-mic").apply { start() }
    }

    @Synchronized
    fun stop() {
        running = false
        thread?.join(500)
        thread = null
    }

    @SuppressLint("MissingPermission")
    private fun record() {
        val minBuffer = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (minBuffer <= 0) {
            fail("This phone cannot record 16 kHz audio.")
            return
        }
        val chunkBytes = SAMPLE_RATE / 10 * 2
        val recorder = createRecorder(maxOf(minBuffer, chunkBytes * 4))
        if (recorder == null) {
            fail("The microphone is unavailable (another app may be using it).")
            return
        }
        // VOICE_RECOGNITION is tuned for speech-to-text; add noise suppression where offered.
        val suppressor = if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(recorder.audioSessionId) else null
        suppressor?.setEnabled(true)
        try {
            recorder.startRecording()
            val buffer = ByteArray(chunkBytes)
            while (running) {
                var filled = 0
                while (running && filled < chunkBytes) {
                    val read = recorder.read(buffer, filled, chunkBytes - filled)
                    if (read < 0) {
                        fail("Microphone read failed ($read).")
                        return
                    }
                    filled += read
                }
                if (running && filled > 0) onChunk(buffer.copyOf(filled), SAMPLE_RATE)
            }
        } catch (error: Exception) {
            Log.w(TAG, "Recording failed", error)
            fail(error.message ?: "Recording failed.")
        } finally {
            try {
                recorder.stop()
            } catch (_: IllegalStateException) {
            }
            suppressor?.release()
            recorder.release()
        }
    }

    @SuppressLint("MissingPermission")
    private fun createRecorder(bufferBytes: Int): AudioRecord? {
        for (source in listOf(MediaRecorder.AudioSource.VOICE_RECOGNITION, MediaRecorder.AudioSource.MIC)) {
            try {
                val recorder = AudioRecord(source, SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufferBytes)
                if (recorder.state == AudioRecord.STATE_INITIALIZED) return recorder
                recorder.release()
            } catch (error: Exception) {
                Log.w(TAG, "Audio source $source unavailable", error)
            }
        }
        return null
    }

    private fun fail(message: String) {
        running = false
        onError(message)
    }

    companion object {
        const val SAMPLE_RATE = 16000
        private const val TAG = "CompanionMic"
    }
}
