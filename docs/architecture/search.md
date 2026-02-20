# Search Architecture

## Introduction

This document covers the application search functionality from the perspective of the engine.  A higher-level document that covers searching from the app, i.e. user, perspective is needed

## Basics

- All searches are case-insensitive.
- Symbols (e.g. '.') will be stripped when parsing search terms, e.g. a search for "semi-annual" becomes a search for the terms "semi" and "annual"
- Words in documents are not stemmed, so "run" will only match "run", not "running" or "runs".  Stemming is done by the application itself
- If a document contains at least one match for a search, then it will be included in the results. If search result context is requested, a document may match multiple times
- Search terms can be combined logically, e.g. "near(this, that) or stuff"; these terms are parsed by the application into a series of reverse polish notation op codes that are processed by the engine

## Search Types

1. In: Matches if _all_ of the terms occur in the document.
2. Near: Matches if all of the terms occur near each other in the document, where "near" is defined as "occurs within 10 words on either side of the previous term". The limit of 10 words is hard-coded and cannot be configured.  Whitespace and symbols are skipped when calculating the distance between terms.  Since each successive term has to occur within 10 words of the _previous_ term, the ordering of the terms is significant, e.g. "this or that" may match documents that "or this that" does not.  Note that reversing the terms will yield the same result, though, e.g. "this or that" will always match if "that or this" does.
> The application does have the syntax in the query parser to change the 10 word "near" and it should be passing it to the engine
3. Any: Matches if _any_ of the terms occurs in the document.
4. Phrase: Matches if the exact sequence of terms is found in the document.  Whitespace and symbols are skipped when matching phrases.
5. Glob: Matches using a [BSD glob pattern](https://en.wikipedia.org/wiki/Glob_(programming)).  The pattern is only applied to individual words in the document, e.g. "this\*that" cannot be used to match "this or that".  
6. Regexp: Matches using an [ECMAScript-style regular expression](http://www.cplusplus.com/reference/regex/ECMAScript/).  The pattern is only applied to individual words in the document, e.g. "this.\*that" cannot be used to match "this or that".  

## Context

All search types support returning search result context as a configurable search option.  The number of words included in the context is also configurable but defaults to 10.  The context will include the specified number of words on either side of the match site as well as the match itself.  For `Phrase` and `Near` searches, the match may contain multiple words.  

Contexts include any symbols or whitespace from the original document, although runs of whitespace are collapsed to a single space.  These symbols and spaces do not count toward the context word count.
