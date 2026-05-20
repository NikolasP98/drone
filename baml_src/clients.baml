// Default client registry for drone streaming functions.
//
// At runtime, callers override the API key + model via BAML's ClientRegistry
// (wired through DroneHost.resolveApiKey). The clients declared here exist so
// .baml functions can compile against named clients; the actual model used is
// chosen per-call by drone, NOT by the static client binding.

client<llm> ClaudeSonnet {
  provider anthropic
  options {
    model "claude-sonnet-4-5-20250929"
    max_tokens 2048
  }
}

client<llm> ClaudeHaiku {
  provider anthropic
  options {
    model "claude-haiku-4-5-20251001"
    max_tokens 2048
  }
}

client<llm> GPT4o {
  provider openai
  options {
    model "gpt-4o"
    max_tokens 2048
  }
}

client<llm> GPT4oMini {
  provider openai
  options {
    model "gpt-4o-mini"
    max_tokens 2048
  }
}
