import sys
import json
from faster_whisper import WhisperModel

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Audio file path is required"}))
        sys.exit(1)

    audio_path = sys.argv[1]

    # Auto-detect GPU/CPU
    try:
        # Try initializing with CUDA
        model = WhisperModel("small", device="cuda", compute_type="int8")
    except Exception:
        # Fallback to CPU if CUDA is not available or fails
        model = WhisperModel("small", device="cpu", compute_type="int8")

    try:
        segments, info = model.transcribe(audio_path, beam_size=5)
        
        output = []
        for segment in segments:
            output.append({
                "start": float(segment.start),
                "end": float(segment.end),
                "text": segment.text.strip()
            })
            
        # Print the JSON output to stdout
        print(json.dumps(output))
    except Exception as e:
        import traceback
        print(json.dumps({"error": traceback.format_exc()}))
        sys.exit(1)

if __name__ == "__main__":
    main()
