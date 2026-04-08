import { useRef, useState, useEffect } from "react";
import { useChat } from "../hooks/useChat";

const backendUrl = import.meta.env.VITE_API_URL || "http://localhost:3125";

export const UI = ({ hidden }) => {
  const input = useRef();
  const { chat, loading, message, playCustomMessage, pythonPlaying } = useChat();

  const [isRecording, setIsRecording] = useState(false);
  const [recordingStatus, setRecordingStatus] = useState("");
  const recognitionRef = useRef(null);
  const lastSentTime = useRef(0);

  // Tracks pythonMode from Node backend (prevents React from sending chat)
  const pythonModeRef = useRef(false);

  // Cross-iframe sync ref
  const isRecordingRef = useRef(false);
  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  // ── Poll pythonMode flag from Node ────────────────────────────────────────
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res  = await fetch(`${backendUrl}/python-mode`);
        const data = await res.json();
        pythonModeRef.current = data.pythonMode === true;
      } catch (_) {
        // Node not ready — silently ignore
      }
    }, 800);
    return () => clearInterval(interval);
  }, []);

  // ── Record toggle ─────────────────────────────────────────────────────────
  const handleRecord = (forceState) => {
    if (!recognitionRef.current) {
      alert("Speech Recognition not supported. Please use Chrome.");
      return;
    }

    const isForced  = typeof forceState === "boolean";
    const nextState = isForced ? forceState : !isRecordingRef.current;

    // If triggered by Gradio postMessage — just update visual state, don't
    // start Web Speech (Gradio mic handles transcription on that side)
    if (isForced) {
      setIsRecording(nextState);
      setRecordingStatus(nextState ? "🎙 Recording via Gradio mic..." : "");
      return;
    }

    // Manual React button click — broadcast to Gradio parent
    window.parent.postMessage(nextState ? "REACT_RCD_START" : "REACT_RCD_STOP", "*");

    if (!nextState && isRecordingRef.current) {
      recognitionRef.current.stop();
      setIsRecording(false);
      setRecordingStatus("");
    } else if (nextState && !isRecordingRef.current) {
      if (input.current) input.current.value = "";
      try {
        recognitionRef.current.start();
        setIsRecording(true);
      } catch (e) {
        console.error("Recognition start error:", e);
        setRecordingStatus("⚠ Could not start mic");
        setTimeout(() => setRecordingStatus(""), 3000);
      }
    }
  };

  // ── postMessage listener (from Gradio iframe parent) ─────────────────────
  useEffect(() => {
    const handleMessage = (e) => {
      if (e.data === "GRADIO_RCD_START") {
        if (!isRecordingRef.current) handleRecord(true);
      } else if (e.data === "GRADIO_RCD_STOP") {
        if (isRecordingRef.current) handleRecord(false);
      } else if (e.data && e.data.type === "PLAY_AVATAR") {
        playCustomMessage(e.data.text, e.data.audio, e.data.lipsync);
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  // ── Setup Web Speech API ──────────────────────────────────────────────────
  useEffect(() => {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      console.warn("Speech Recognition not supported. Use Chrome.");
      return;
    }

    const recognition        = new SpeechRecognition();
    recognition.lang         = "hi-IN";   // change to "en-US" for English
    recognition.continuous   = false;
    recognition.interimResults = false;

    recognition.onstart = () => {
      setRecordingStatus("🎙 Listening...");
    };

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      console.log("✅ React Speech transcript:", transcript);

      if (input.current) input.current.value = transcript;

      setIsRecording(false);
      setRecordingStatus("✓ Sending...");

      setTimeout(() => {
        // ✅ Don't send if Python is currently in charge
        if (pythonModeRef.current) {
          console.log("🔇 React speech blocked — Python mode active");
          setRecordingStatus("");
          return;
        }
        if (pythonPlaying) return;
        const text = input.current?.value?.trim();
        if (text && Date.now() - lastSentTime.current > 3000) {
          console.log("🚀 Auto-sending from React Speech:", text);
          lastSentTime.current = Date.now();
          chat(text);
          input.current.value = "";
          setRecordingStatus("");
        }
      }, 400);
    };

    recognition.onerror = (event) => {
      console.error("Speech error:", event.error);
      setIsRecording(false);
      setRecordingStatus("⚠ Error: " + event.error);
      setTimeout(() => setRecordingStatus(""), 3000);
    };

    recognition.onend = () => {
      setIsRecording(false);
    };

    recognitionRef.current = recognition;
  }, []);

  // ── Poll Node for Gradio mic transcript ───────────────────────────────────
  useEffect(() => {
    const interval = setInterval(async () => {
      // ✅ KEY FIX: skip entirely if Python is in charge
      if (pythonModeRef.current) return;
if (pythonPlaying) return;
      try {
        const res  = await fetch(`${backendUrl}/get-transcript`);
        const data = await res.json();

        if (data.transcript?.trim()) {
          const text = data.transcript.trim();
          console.log("📥 Transcript from Gradio poll:", text);

          if (input.current) input.current.value = text;
          setRecordingStatus("✓ Sending...");

          setTimeout(() => {
            if (pythonModeRef.current) {
              setRecordingStatus("");
              return;
            }
            const currentText = input.current?.value?.trim();
            if (currentText && Date.now() - lastSentTime.current > 3000) {
              console.log("🚀 Auto-sending from Gradio poll:", currentText);
              lastSentTime.current = Date.now();
              chat(currentText);
              input.current.value = "";
              setRecordingStatus("");
            }
          }, 400);
        }
      } catch (_) {
        // backend not ready — silently ignore
      }
    }, 1500);

    return () => clearInterval(interval);
  }, []);

  // ── Manual send (Enter key or Send button) ────────────────────────────────
  const sendMessage = () => {
    // ✅ Block while Python is speaking
    if (pythonModeRef.current) return;

    const text = input.current?.value?.trim();
    if (!text || loading) return;

    console.log("✅ Sending:", text);
    lastSentTime.current = Date.now();
    chat(text);
    input.current.value = "";
    setRecordingStatus("");
  };

  if (hidden) return null;

  return (
    <div className="fixed inset-0 z-10 pointer-events-none flex flex-col justify-end">
      <div className="w-full max-w-3xl mx-auto mb-6 px-4 pointer-events-auto">

        {/* Python speaking badge */}
        {pythonPlaying && (
          <div className="mb-2 flex justify-center">
            <span className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-sm font-medium shadow bg-blue-100 text-blue-700 border border-blue-300">
              <span className="w-2 h-2 rounded-full bg-blue-500 animate-ping inline-block" />
              🩺 Doctor is speaking...
            </span>
          </div>
        )}

        {/* Recording / status badge */}
        {!pythonPlaying && (isRecording || recordingStatus) && (
          <div className="mb-2 flex justify-center">
            <span
              className={`inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-sm font-medium shadow
                ${isRecording
                  ? "bg-red-100 text-red-700 border border-red-300"
                  : "bg-green-100 text-green-700 border border-green-300"
                }`}
            >
              {isRecording && (
                <span className="w-2 h-2 rounded-full bg-red-500 animate-ping inline-block" />
              )}
              {isRecording ? "Recording... speak now" : recordingStatus}
            </span>
          </div>
        )}

        {/* Chat bar — visually dimmed while Python is speaking */}
        <div
          className={`flex items-center gap-3 bg-white/90 border border-gray-200 shadow-xl rounded-2xl p-3 transition-opacity duration-300
            ${pythonPlaying ? "opacity-40 pointer-events-none" : "opacity-100"}`}
        >
          {/* 🎙 Record Button */}
          <button
            onClick={handleRecord}
            disabled={pythonPlaying}
            title={isRecording ? "Stop recording" : "Start voice recording"}
            className={`flex-shrink-0 px-4 py-3 rounded-xl text-white font-semibold transition-all duration-200 select-none
              ${isRecording
                ? "bg-red-500 hover:bg-red-600 scale-95 animate-pulse"
                : "bg-purple-600 hover:bg-purple-700"
              }`}
          >
            {isRecording ? "⏹ Stop" : "🎙 Record"}
          </button>

          {/* Text Input */}
          <input
            ref={input}
            placeholder={pythonPlaying ? "Doctor is speaking..." : "Talk to your AI Doctor..."}
            disabled={pythonPlaying}
            className="flex-1 p-3 rounded-xl outline-none bg-gray-50 text-gray-800 placeholder-gray-400 disabled:cursor-not-allowed"
            onKeyDown={(e) => {
              if (e.key === "Enter") sendMessage();
            }}
          />

          {/* Send Button */}
          <button
            onClick={sendMessage}
            disabled={loading || pythonPlaying}
            className={`flex-shrink-0 px-6 py-3 rounded-xl text-white font-semibold transition-all duration-200
              ${loading || pythonPlaying
                ? "bg-gray-400 cursor-not-allowed"
                : "bg-blue-600 hover:bg-blue-700"
              }`}
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Wait
              </span>
            ) : (
              "Send"
            )}
          </button>
        </div>

        {/* Hint */}
        <p className="text-center text-xs text-gray-400 mt-2 select-none">
          Press <kbd className="px-1 py-0.5 bg-gray-100 rounded text-gray-500 text-xs">Enter</kbd> to send ·
          🎙 Record fills the input automatically
        </p>

      </div>
    </div>
  );
};