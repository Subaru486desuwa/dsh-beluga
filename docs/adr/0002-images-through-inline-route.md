# Images go only through Beluga's inline route

Beluga sends images only through its own OpenAI-compatible inline route, which carries the bytes inside each request. Harness routes take images only as references owned by the Harness attachment service, so using them would put Chat image bytes, including Temporary Chat ones, under host storage and retention. That would need the new retention and deletion interfaces that ADR 0001 avoids.

The cost is a second client for image-capable models. That client must carry reasoning effort and reasoning output itself. Image-capable models always use the inline route in Beluga, so Harness route settings for those models do not apply to Chat.
