<?xml version="1.0" encoding="UTF-8"?>
<!--
    XSLT to convert TEI biblStruct elements to CSV format.
    Headers are lowercased to match the requirement.
-->
<xsl:stylesheet version="1.0"
    xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
    xmlns:tei="http://www.tei-c.org/ns/1.0">
    <xsl:output method="html" encoding="UTF-8" indent="no" />
    <xsl:strip-space elements="*" />

    <xsl:template match="text()" />

    <xsl:template match="/">
        <html>
            <body>
                <pre>type,authors,title,journal_book,year,volume,issue,pages,publisher,place</pre> 
                <pre><xsl:apply-templates select="//tei:biblStruct" /></pre>
            </body>
        </html>
    </xsl:template>    

    <!-- Template for quoted CSV fields with optional trailing comma -->
    <xsl:template name="csv-field">
        <xsl:param name="value" />
        <xsl:param name="last" select="false()" />
        <xsl:text>"</xsl:text>
        <xsl:value-of select="$value" />
        <xsl:text>"</xsl:text>
        <xsl:if test="not($last)">
            <xsl:text>,</xsl:text>
        </xsl:if>
    </xsl:template>

    <!-- Template for unquoted CSV fields with optional trailing comma -->
    <xsl:template name="csv-field-unquoted">
        <xsl:param name="value" />
        <xsl:param name="last" select="false()" />
        <xsl:value-of select="$value" />
        <xsl:if test="not($last)">
            <xsl:text>,</xsl:text>
        </xsl:if>
    </xsl:template>

    <xsl:template match="tei:biblStruct">
        <!-- CSV Data Row -->
        <!-- Type -->
        <xsl:call-template name="csv-field">
            <xsl:with-param name="value">
                <xsl:choose>
                    <xsl:when test="descendant::tei:title[@level='j']">Journal</xsl:when>
                    <xsl:when
                        test="descendant::tei:title[@level='m'] and descendant::tei:title[@level='a']">
                        Chapter</xsl:when>
                    <xsl:otherwise>Book</xsl:otherwise>
                </xsl:choose>
            </xsl:with-param>
        </xsl:call-template>
        <!-- Authors -->
        <xsl:call-template name="csv-field">
            <xsl:with-param name="value">
                <xsl:for-each select=".//tei:author">
                    <xsl:if test="position() > 1">; </xsl:if>
                    <xsl:value-of select="normalize-space(.//tei:surname)" />
                    <xsl:if test=".//tei:forename">
                        <xsl:text>, </xsl:text>
                        <xsl:value-of select="normalize-space(.//tei:forename)" />
                    </xsl:if>
                </xsl:for-each>
            </xsl:with-param>
        </xsl:call-template>
        <!-- Title -->
        <xsl:call-template name="csv-field">
            <xsl:with-param name="value">
                <xsl:choose>
                    <xsl:when test="tei:analytic/tei:title">
                        <xsl:value-of select="normalize-space(tei:analytic/tei:title)" />
                    </xsl:when>
                    <xsl:otherwise>
                        <xsl:value-of select="normalize-space(tei:monogr/tei:title)" />
                    </xsl:otherwise>
                </xsl:choose>
            </xsl:with-param>
        </xsl:call-template>
        <!-- Journal/Book (secondary title) -->
        <xsl:call-template name="csv-field">
            <xsl:with-param name="value">
                <xsl:choose>
                    <xsl:when test="tei:analytic">
                        <xsl:value-of select="normalize-space(tei:monogr/tei:title)" />
                    </xsl:when>
                    <xsl:otherwise></xsl:otherwise>
                </xsl:choose>
            </xsl:with-param>
        </xsl:call-template>
        <!-- Year -->
        <xsl:call-template name="csv-field">
            <xsl:with-param name="value">
                <xsl:value-of select="normalize-space(.//tei:date)" />
            </xsl:with-param>
        </xsl:call-template>
        <!-- Volume -->
        <xsl:call-template name="csv-field">
            <xsl:with-param name="value">
                <xsl:value-of
                    select="normalize-space(.//tei:biblScope[@unit='volume' or @unit='vol'])" />
            </xsl:with-param>
        </xsl:call-template>
        <!-- Issue -->
        <xsl:call-template name="csv-field">
            <xsl:with-param name="value">
                <xsl:value-of select="normalize-space(.//tei:biblScope[@unit='issue'])" />
            </xsl:with-param>
        </xsl:call-template>
        <!-- Pages -->
        <xsl:call-template name="csv-field">
            <xsl:with-param name="value">
                <xsl:value-of select="normalize-space(.//tei:biblScope[@unit='pp' or @unit='page'])" />
            </xsl:with-param>
        </xsl:call-template>
        <!-- Publisher -->
        <xsl:call-template name="csv-field">
            <xsl:with-param name="value">
                <xsl:value-of select="normalize-space(.//tei:publisher)" />
            </xsl:with-param>
        </xsl:call-template>
        <!-- Place -->
        <xsl:call-template name="csv-field">
            <xsl:with-param name="value">
                <xsl:value-of select="normalize-space(.//tei:pubPlace)" />
            </xsl:with-param>
            <xsl:with-param name="last" select="true()" />
        </xsl:call-template>
        <xsl:text>&#10;</xsl:text>
    </xsl:template>

</xsl:stylesheet>