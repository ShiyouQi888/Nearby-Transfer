; 邻传 NSIS 品牌主题：柔和浅绿灰内容区、深绿正文，侧栏/页眉使用品牌图。
; NSIS color values use RRGGBB without a leading #.
!define MUI_BGCOLOR "F3F8F5"
!define MUI_TEXTCOLOR "1D2B24"
; License content has a separate background setting from the page itself.
!define MUI_LICENSEPAGE_BGCOLOR "F3F8F5"
; Keep the user's language choice across the elevated UAC child process.
!define MUI_LANGDLL_REGISTRY_ROOT HKCU
!define MUI_LANGDLL_REGISTRY_KEY "Software\Nearby Transfer\Installer"
!define MUI_LANGDLL_REGISTRY_VALUENAME "Language"
!define MUI_ABORTWARNING

!macro customInit
  !ifndef BUILD_UNINSTALLER
    ${If} ${UAC_IsInnerInstance}
      DeleteRegValue HKCU "Software\Nearby Transfer\Installer" "Language"
    ${Else}
      WriteRegStr HKCU "Software\Nearby Transfer\Installer" "Language" $LANGUAGE
    ${EndIf}
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
Function .onGUIEnd
  DeleteRegValue HKCU "Software\Nearby Transfer\Installer" "Language"
FunctionEnd
!endif
