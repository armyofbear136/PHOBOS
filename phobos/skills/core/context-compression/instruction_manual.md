# Context Compression

When summarising files and assembling context for SEREN, apply these compression principles:

**Preserve unconditionally:**
- Function signatures, class names, exported symbols, API contracts
- Error messages, constraint definitions, and explicit user requirements
- File paths and the relationships between files
- Any data whose omission would change SEREN's decision

**Compress aggressively:**
- Boilerplate, license headers, repetitive import blocks
- Inline comments that restate what the code visibly does
- Large data literals (summarise the shape, not every value)
- Duplicate information already captured in another file summary

**Summarisation rule:** One summary per file. State what the file IS and what it EXPORTS. Do not pad. Every token costs — spend them only where SEREN needs them.

**Rewrite rule:** The reformulated prompt must contain exactly the information SEREN needs to plan correctly and nothing more. Resolve ambiguity. Name the files. State the outcome. Strip the prose.