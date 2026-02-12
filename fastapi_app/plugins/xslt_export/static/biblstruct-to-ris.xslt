<?xml version="1.0" encoding="UTF-8"?>
<!--
    Original author: A. Charles Muller, Professor Emeritus, Faculty of Letters, University of Tokyo
    Source archived at
https://web.archive.org/web/20260205190553/http://www.acmuller.net/xml-tei-tut/biblStruct-to-RIS.xsl
    Modified to use XSLT 1.0 with explicit namespace prefixes for browser compatibility.
-->
<xsl:stylesheet version="1.0"
    xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
    xmlns:tei="http://www.tei-c.org/ns/1.0">
    <xsl:output method="html" encoding="UTF-8" indent="yes" />
    <xsl:strip-space elements="*"/>

    <!-- Suppress unwanted text nodes -->
    <xsl:template match="text()"/>

    <xsl:template match="/">
        <html>
            <body>
                <pre>
                    <xsl:apply-templates select="//tei:listBibl" />
                </pre>
            </body>
        </html>
    </xsl:template>

    <xsl:template match="tei:listBibl">
        <xsl:for-each select="tei:biblStruct">
            <xsl:choose>
                <xsl:when test="descendant::tei:title[@level='j']">
                    <xsl:text>TY - JOUR</xsl:text>
                    <br />
                </xsl:when>
                <xsl:when test="descendant::tei:title[@level='m'] and descendant::tei:title[@level='a']">
                    <xsl:text>TY - CHAP</xsl:text>
                    <br />
                </xsl:when>
                <xsl:otherwise>
                    <xsl:text>TY - BOOK</xsl:text>
                    <br />
                </xsl:otherwise>
            </xsl:choose>
            <xsl:apply-templates />
            <xsl:text>ER - </xsl:text>
            <br /><br />
        </xsl:for-each>
    </xsl:template>

    <xsl:template match="tei:author">
        <xsl:text>AU - </xsl:text>
        <xsl:value-of select="normalize-space(.//tei:surname)"/>
        <xsl:text>, </xsl:text>
        <xsl:value-of select="normalize-space(.//tei:forename)"/>
        <br />
    </xsl:template>

    <xsl:template match="tei:editor">
        <xsl:text>A3 - </xsl:text>
        <xsl:value-of select="normalize-space(.//tei:surname)"/>
        <xsl:text>, </xsl:text>
        <xsl:value-of select="normalize-space(.//tei:forename)"/>
        <br />
    </xsl:template>

    <xsl:template match="tei:title">
        <xsl:choose>
            <xsl:when test="@level='a'">
                <xsl:text>TI - </xsl:text>
                <xsl:value-of select="normalize-space(.)"/>
                <br />
            </xsl:when>
            <xsl:when test="@level='j'">
                <xsl:text>T2 - </xsl:text>
                <xsl:value-of select="normalize-space(.)"/>
                <br />
            </xsl:when>
            <xsl:when test="@level='m' and ancestor::tei:biblStruct[1]/tei:analytic/tei:title[@level='a']">
                <xsl:choose>
                    <xsl:when test="parent::tei:title[@level='a']">
                        <xsl:value-of select="normalize-space(.)"/>
                    </xsl:when>
                    <xsl:otherwise>
                        <xsl:text>T2 - </xsl:text>
                        <xsl:value-of select="normalize-space(.)"/>
                        <br />
                    </xsl:otherwise>
                </xsl:choose>
            </xsl:when>
            <xsl:otherwise>
                <xsl:text>TI - </xsl:text>
                <xsl:value-of select="normalize-space(.)"/>
                <br />
            </xsl:otherwise>
        </xsl:choose>
    </xsl:template>

    <xsl:template match="tei:pubPlace">
        <xsl:text>CY - </xsl:text>
        <xsl:value-of select="normalize-space(.)"/>
        <br />
    </xsl:template>

    <xsl:template match="tei:publisher">
        <xsl:text>PB - </xsl:text>
        <xsl:value-of select="normalize-space(.)"/>
        <br />
    </xsl:template>

    <xsl:template match="tei:date">
        <xsl:text>PY - </xsl:text>
        <xsl:value-of select="normalize-space(.)"/>
        <br />
    </xsl:template>

    <xsl:template match="tei:biblScope">
        <xsl:choose>
            <xsl:when test="@unit='vol' or @unit='volume'">
                <xsl:text>VL - </xsl:text>
                <xsl:value-of select="normalize-space(.)"/>
                <br />
            </xsl:when>
            <xsl:when test="@unit='issue'">
                <xsl:text>IS - </xsl:text>
                <xsl:value-of select="normalize-space(.)"/>
                <br />
            </xsl:when>
        </xsl:choose>
    </xsl:template>

    <xsl:template match="tei:biblScope[@unit='pp']">
        <xsl:variable name="pText" select="." />
        <xsl:if test="contains($pText, '–')">
            <xsl:text>SP - </xsl:text>
            <xsl:value-of select="substring-before($pText, '–')" />
            <br />
            <xsl:text>EP - </xsl:text>
            <xsl:value-of select="substring-after($pText, '–')" />
            <br />
        </xsl:if>
        <xsl:if test="contains($pText, '-')">
            <xsl:text>SP - </xsl:text>
            <xsl:value-of select="substring-before($pText, '-')" />
            <br />
            <xsl:text>EP - </xsl:text>
            <xsl:value-of select="substring-after($pText, '-')" />
            <br />
        </xsl:if>
    </xsl:template>

    <xsl:template match="tei:note">
        <xsl:text>N1 - </xsl:text>
        <xsl:value-of select="normalize-space(.)"/>
        <br />
    </xsl:template>


</xsl:stylesheet>