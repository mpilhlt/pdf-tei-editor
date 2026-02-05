<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:tei="http://www.tei-c.org/ns/1.0">

  <xsl:output method="html" encoding="UTF-8" indent="yes"/>

  <xsl:template match="/">
    <html>
      <head>
        <style>
          body { font-family: system-ui, sans-serif; padding: 16px; line-height: 1.5; }
          h2 { margin-top: 0; color: #333; }
          ol { padding-left: 24px; }
          li { margin-bottom: 8px; padding: 8px; background: #f5f5f5; border-radius: 4px; }
          .count { color: #666; font-size: 0.9em; margin-bottom: 16px; }
        </style>
      </head>
      <body>
        <h2><xsl:value-of select="//tei:title" /></h2>
        <p class="count">
          <xsl:value-of select="count(//tei:biblStruct)"/> references found
        </p>
        <ol>
          <xsl:apply-templates select="//tei:biblStruct"/>
        </ol>
      </body>
    </html>
  </xsl:template>

  <xsl:template match="tei:biblStruct">
    <li>
      <xsl:value-of select="normalize-space(.)"/>
    </li>
  </xsl:template>

</xsl:stylesheet>
