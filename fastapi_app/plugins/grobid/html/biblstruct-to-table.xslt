<?xml version="1.0" encoding="UTF-8"?>
<!--
    XSLT to convert TEI biblStruct elements to an HTML table for Excel export.
-->
<xsl:stylesheet version="1.0"
    xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
    xmlns:tei="http://www.tei-c.org/ns/1.0">
    <xsl:output method="html" encoding="UTF-8" indent="yes" />
    <xsl:strip-space elements="*"/>

    <xsl:template match="text()"/>

    <xsl:template match="/">
        <html>
            <body>
                <div class="table-wrapper">
                <style>
                    div.table-wrapper { font-family: Calibri, Arial, sans-serif; font-size: 8pt; padding: 0; margin: 0; }
                    .table-wrapper { width: 100%; }
                    table { border-collapse: collapse; width: 100%; table-layout: fixed; }
                    th, td { border: 1px solid #d0d0d0; padding: 4px 8px; text-align: left; vertical-align: middle; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                    th { background: #e8e8e8; font-weight: bold; position: sticky; top: 0; }
                    tr:hover { background: #e8f4fc; }
                    td { background: white; }
                    /* Column widths */
                    th:nth-child(1), td:nth-child(1) { width: 6%; }  /* Type */
                    th:nth-child(2), td:nth-child(2) { width: 15%; } /* Authors */
                    th:nth-child(3), td:nth-child(3) { width: 20%; } /* Title */
                    th:nth-child(4), td:nth-child(4) { width: 20%; } /* Journal/Book */
                    th:nth-child(5), td:nth-child(5) { width: 5%; }  /* Year */
                    th:nth-child(6), td:nth-child(6) { width: 5%; }  /* Volume */
                    th:nth-child(7), td:nth-child(7) { width: 5%; }  /* Issue */
                    th:nth-child(8), td:nth-child(8) { width: 6%; }  /* Pages */
                    th:nth-child(9), td:nth-child(9) { width: 10%; } /* Publisher */
                    th:nth-child(10), td:nth-child(10) { width: 8%; } /* Place */
                </style>                    
                <table>
                    <thead>
                        <tr>
                            <th>Type</th>
                            <th>Authors</th>
                            <th>Title</th>
                            <th>Journal/Book</th>
                            <th>Year</th>
                            <th>Volume</th>
                            <th>Issue</th>
                            <th>Pages</th>
                            <th>Publisher</th>
                            <th>Place</th>
                        </tr>
                    </thead>
                    <tbody>
                        <xsl:apply-templates select="//tei:biblStruct"/>
                    </tbody>
                </table>
                </div>
            </body>
        </html>
    </xsl:template>

    <xsl:template match="tei:biblStruct">
        <tr>
            <!-- Type -->
            <td>
                <xsl:choose>
                    <xsl:when test="descendant::tei:title[@level='j']">Journal</xsl:when>
                    <xsl:when test="descendant::tei:title[@level='m'] and descendant::tei:title[@level='a']">Chapter</xsl:when>
                    <xsl:otherwise>Book</xsl:otherwise>
                </xsl:choose>
            </td>
            <!-- Authors -->
            <td>
                <xsl:for-each select=".//tei:author">
                    <xsl:if test="position() > 1">; </xsl:if>
                    <xsl:value-of select="normalize-space(.//tei:surname)"/>
                    <xsl:if test=".//tei:forename">
                        <xsl:text>, </xsl:text>
                        <xsl:value-of select="normalize-space(.//tei:forename)"/>
                    </xsl:if>
                </xsl:for-each>
            </td>
            <!-- Title -->
            <td>
                <xsl:choose>
                    <xsl:when test="tei:analytic/tei:title">
                        <xsl:value-of select="normalize-space(tei:analytic/tei:title)"/>
                    </xsl:when>
                    <xsl:otherwise>
                        <xsl:value-of select="normalize-space(tei:monogr/tei:title)"/>
                    </xsl:otherwise>
                </xsl:choose>
            </td>
            <!-- Journal/Book (secondary title) -->
            <td>
                <xsl:if test="tei:analytic">
                    <xsl:value-of select="normalize-space(tei:monogr/tei:title)"/>
                </xsl:if>
            </td>
            <!-- Year -->
            <td>
                <xsl:value-of select="normalize-space(.//tei:date)"/>
            </td>
            <!-- Volume -->
            <td>
                <xsl:value-of select="normalize-space(.//tei:biblScope[@unit='volume' or @unit='vol'])"/>
            </td>
            <!-- Issue -->
            <td>
                <xsl:value-of select="normalize-space(.//tei:biblScope[@unit='issue'])"/>
            </td>
            <!-- Pages -->
            <td>
                <xsl:value-of select="normalize-space(.//tei:biblScope[@unit='pp' or @unit='page'])"/>
            </td>
            <!-- Publisher -->
            <td>
                <xsl:value-of select="normalize-space(.//tei:publisher)"/>
            </td>
            <!-- Place -->
            <td>
                <xsl:value-of select="normalize-space(.//tei:pubPlace)"/>
            </td>
        </tr>
    </xsl:template>

</xsl:stylesheet>
