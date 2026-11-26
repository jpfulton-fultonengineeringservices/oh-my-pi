Search long-term memory for the records bearing on a question; return the matching entries, attributed to their source.

Use for open-ended questions spanning many stored facts: "What do you know about this user?", "What decisions were made on this project?", "What are my preferences for X?" — where the answer needs several records rather than one, and you will read them yourself.

Unlike `{{toolRefs.recall}}`, which answers a specific lookup, this widens the net: it ranks a handful of the best-matching memories and returns them with their provenance so you weigh them. It does NOT generate an answer for you, and it never paraphrases a stored record — you get the retrieval, not a summary of it.

`context` optional; biases the ranking toward a specific angle or sub-topic.

`{{toolRefs.memory_search}}`: the records bearing on a broader question. `{{toolRefs.recall}}`: one specific fact or entry.
