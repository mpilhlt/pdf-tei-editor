<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0"
    xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
    xmlns:tei="http://www.tei-c.org/ns/1.0"
    exclude-result-prefixes="tei">

  <xsl:output method="html" indent="no" encoding="UTF-8"/>

  <!-- Root template - wrap in HTML -->
  <xsl:template match="/">
    <html>
      <head>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            margin: 0;
            padding: 20px;
            background: #f5f5f5;
          }
          .xml-output {
            background: white;
            border: 1px solid #ddd;
            border-radius: 4px;
            padding: 0;
            margin: 0;
          }
          pre {
            margin: 0;
            padding: 16px;
            overflow-x: auto;
          }
          code {
            font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas', monospace;
            font-size: 13px;
            line-height: 1.5;
          }
          h2 {
            margin: 0 0 16px 0;
            padding: 12px 16px;
            background: #f8f9fa;
            border-bottom: 1px solid #ddd;
            font-size: 16px;
            font-weight: 600;
          }
          #crossref-xml {
            display: none;
          }
        </style>
      </head>
      <body>
        <div class="xml-output">
          <h2>CrossRef XML Output</h2>
          <pre><code class="language-xml xsl-xml-target"></code></pre>
        </div>
        <!-- Store XML in hidden div with xsl-xml-source class -->
        <div class="xsl-xml-source" style="display: none;">
          <xsl:apply-templates select="//tei:TEI" mode="crossref-xml"/>
        </div>
      </body>
    </html>
  </xsl:template>

  <!-- Generate CrossRef XML structure -->
  <xsl:template match="tei:TEI" mode="crossref-xml">
    <doi_batch version="5.4.0" xmlns="http://www.crossref.org/schema/5.4.0">
      <head>
        <doi_batch_id>
          <xsl:value-of select="concat('batch_', generate-id())"/>
        </doi_batch_id>
        <timestamp>20260101000000</timestamp>
        <depositor>
          <depositor_name>PDF-TEI-Editor</depositor_name>
          <email_address>noreply@example.org</email_address>
        </depositor>
        <registrant>PDF-TEI-Editor</registrant>
      </head>
      <body>
        <journal>
          <journal_metadata>
            <full_title>
              <xsl:choose>
                <xsl:when test=".//tei:sourceDesc//tei:title[@level='j']">
                  <xsl:value-of select=".//tei:sourceDesc//tei:title[@level='j']"/>
                </xsl:when>
                <xsl:otherwise>Unknown Journal</xsl:otherwise>
              </xsl:choose>
            </full_title>
          </journal_metadata>

          <xsl:if test=".//tei:publicationStmt/tei:date[@type='publication'] or .//tei:sourceDesc//tei:biblScope[@unit='volume'] or .//tei:sourceDesc//tei:biblScope[@unit='issue']">
            <journal_issue>
              <publication_date media_type="online">
                <xsl:call-template name="extract-date">
                  <xsl:with-param name="date" select=".//tei:publicationStmt/tei:date[@type='publication']/@when"/>
                </xsl:call-template>
              </publication_date>

              <xsl:if test=".//tei:sourceDesc//tei:biblScope[@unit='volume']">
                <journal_volume>
                  <volume>
                    <xsl:value-of select=".//tei:sourceDesc//tei:biblScope[@unit='volume']"/>
                  </volume>
                </journal_volume>
              </xsl:if>

              <xsl:if test=".//tei:sourceDesc//tei:biblScope[@unit='issue']">
                <issue>
                  <xsl:value-of select=".//tei:sourceDesc//tei:biblScope[@unit='issue']"/>
                </issue>
              </xsl:if>
            </journal_issue>
          </xsl:if>

          <journal_article publication_type="full_text">
            <titles>
              <title>
                <xsl:value-of select=".//tei:titleStmt/tei:title[@level='a']"/>
              </title>
            </titles>

            <xsl:if test=".//tei:titleStmt/tei:author">
              <contributors>
                <xsl:for-each select=".//tei:titleStmt/tei:author">
                  <person_name>
                    <xsl:attribute name="sequence">
                      <xsl:choose>
                        <xsl:when test="position() = 1">first</xsl:when>
                        <xsl:otherwise>additional</xsl:otherwise>
                      </xsl:choose>
                    </xsl:attribute>
                    <xsl:attribute name="contributor_role">author</xsl:attribute>

                    <xsl:if test=".//tei:forename">
                      <given_name>
                        <xsl:value-of select=".//tei:forename"/>
                      </given_name>
                    </xsl:if>
                    <surname>
                      <xsl:value-of select=".//tei:surname"/>
                    </surname>
                  </person_name>
                </xsl:for-each>
              </contributors>
            </xsl:if>

            <publication_date media_type="online">
              <xsl:call-template name="extract-date">
                <xsl:with-param name="date" select=".//tei:publicationStmt/tei:date[@type='publication']/@when"/>
              </xsl:call-template>
            </publication_date>

            <xsl:if test=".//tei:sourceDesc//tei:biblScope[@unit='page']">
              <pages>
                <xsl:variable name="pages" select=".//tei:sourceDesc//tei:biblScope[@unit='page']"/>
                <xsl:choose>
                  <xsl:when test="contains($pages, '-')">
                    <first_page>
                      <xsl:value-of select="substring-before($pages, '-')"/>
                    </first_page>
                    <last_page>
                      <xsl:value-of select="substring-after($pages, '-')"/>
                    </last_page>
                  </xsl:when>
                  <xsl:otherwise>
                    <first_page>
                      <xsl:value-of select="$pages"/>
                    </first_page>
                  </xsl:otherwise>
                </xsl:choose>
              </pages>
            </xsl:if>

            <doi_data>
              <doi>
                <xsl:choose>
                  <xsl:when test=".//tei:publicationStmt/tei:idno[@type='DOI']">
                    <xsl:value-of select=".//tei:publicationStmt/tei:idno[@type='DOI']"/>
                  </xsl:when>
                  <xsl:otherwise>10.0000/example</xsl:otherwise>
                </xsl:choose>
              </doi>
              <resource>
                <xsl:choose>
                  <xsl:when test=".//tei:publicationStmt/tei:idno[@type='DOI']">
                    <xsl:value-of select="concat('https://doi.org/', .//tei:publicationStmt/tei:idno[@type='DOI'])"/>
                  </xsl:when>
                  <xsl:otherwise>https://example.org</xsl:otherwise>
                </xsl:choose>
              </resource>
            </doi_data>

            <xsl:if test=".//tei:listBibl/tei:biblStruct">
              <citation_list>
                <xsl:for-each select=".//tei:listBibl/tei:biblStruct">
                  <citation>
                    <xsl:attribute name="key">
                      <xsl:value-of select="concat('ref', position())"/>
                    </xsl:attribute>

                    <xsl:if test=".//tei:analytic/tei:title">
                      <article_title>
                        <xsl:value-of select=".//tei:analytic/tei:title"/>
                      </article_title>
                    </xsl:if>

                    <xsl:if test=".//tei:analytic/tei:author">
                      <xsl:for-each select=".//tei:analytic/tei:author[position() &lt;= 1]">
                        <author>
                          <xsl:value-of select=".//tei:surname"/>
                        </author>
                      </xsl:for-each>
                    </xsl:if>

                    <xsl:if test=".//tei:monogr/tei:title[@level='j']">
                      <journal_title>
                        <xsl:value-of select=".//tei:monogr/tei:title[@level='j']"/>
                      </journal_title>
                    </xsl:if>

                    <xsl:if test=".//tei:monogr//tei:biblScope[@unit='volume']">
                      <volume>
                        <xsl:value-of select=".//tei:monogr//tei:biblScope[@unit='volume']"/>
                      </volume>
                    </xsl:if>

                    <xsl:if test=".//tei:monogr//tei:biblScope[@unit='issue']">
                      <issue>
                        <xsl:value-of select=".//tei:monogr//tei:biblScope[@unit='issue']"/>
                      </issue>
                    </xsl:if>

                    <xsl:if test=".//tei:monogr//tei:biblScope[@unit='page']">
                      <xsl:variable name="pages" select=".//tei:monogr//tei:biblScope[@unit='page']"/>
                      <first_page>
                        <xsl:choose>
                          <xsl:when test="contains($pages, '-')">
                            <xsl:value-of select="substring-before($pages, '-')"/>
                          </xsl:when>
                          <xsl:otherwise>
                            <xsl:value-of select="$pages"/>
                          </xsl:otherwise>
                        </xsl:choose>
                      </first_page>
                    </xsl:if>

                    <xsl:if test=".//tei:monogr/tei:imprint/tei:date">
                      <cYear>
                        <xsl:choose>
                          <xsl:when test=".//tei:monogr/tei:imprint/tei:date/@when">
                            <xsl:value-of select="substring(.//tei:monogr/tei:imprint/tei:date/@when, 1, 4)"/>
                          </xsl:when>
                          <xsl:otherwise>
                            <xsl:value-of select="substring(.//tei:monogr/tei:imprint/tei:date, 1, 4)"/>
                          </xsl:otherwise>
                        </xsl:choose>
                      </cYear>
                    </xsl:if>

                    <xsl:if test=".//tei:idno[@type='DOI']">
                      <doi>
                        <xsl:value-of select=".//tei:idno[@type='DOI']"/>
                      </doi>
                    </xsl:if>
                  </citation>
                </xsl:for-each>
              </citation_list>
            </xsl:if>
          </journal_article>
        </journal>
      </body>
    </doi_batch>
  </xsl:template>

  <!-- Helper template to extract date components -->
  <xsl:template name="extract-date">
    <xsl:param name="date"/>
    <xsl:if test="$date">
      <xsl:variable name="year" select="substring($date, 1, 4)"/>
      <xsl:variable name="month" select="substring($date, 6, 2)"/>
      <xsl:variable name="day" select="substring($date, 9, 2)"/>

      <xsl:if test="$month != ''">
        <month>
          <xsl:value-of select="$month"/>
        </month>
      </xsl:if>
      <xsl:if test="$day != ''">
        <day>
          <xsl:value-of select="$day"/>
        </day>
      </xsl:if>
      <year>
        <xsl:value-of select="$year"/>
      </year>
    </xsl:if>
  </xsl:template>

</xsl:stylesheet>
