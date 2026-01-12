# Syntax Highlighting Test

This document demonstrates syntax highlighting in code blocks.

## XML Example

```xml
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Example Document</title>
      </titleStmt>
    </fileDesc>
  </teiHeader>
  <text>
    <body>
      <p>Example content</p>
    </body>
  </text>
</TEI>
```

## JavaScript Example

```javascript
function greet(name) {
  const message = `Hello, ${name}!`
  console.log(message)
  return message
}

greet('World')
```

## JSON Example

```json
{
  "name": "pdf-tei-editor",
  "version": "0.25.0",
  "dependencies": {
    "highlight.js": "^11.9.0",
    "markdown-it": "^14.0.0"
  }
}
```

## Python Example

```python
def calculate_sum(numbers):
    """Calculate the sum of a list of numbers."""
    total = 0
    for num in numbers:
        total += num
    return total

result = calculate_sum([1, 2, 3, 4, 5])
print(f"Sum: {result}")
```

## Plain Text (No Highlighting)

```
This is plain text without any syntax highlighting.
It will still be formatted as a code block.
```
