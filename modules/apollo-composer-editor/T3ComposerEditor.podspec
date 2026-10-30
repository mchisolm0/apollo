require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'T3ComposerEditor'
  s.version = package['version']
  s.summary = 'Native composer editor for Apollo, ported from T3 Code.'
  s.description = 'UIKit-backed composer with atomic skill chips, image and long-text paste, and hardware Return handling.'
  s.homepage = 'https://github.com/mchisolm0/apollo'
  s.license = { :type => 'MIT' }
  s.author = 'Apollo'
  s.platforms = { :ios => '16.4' }
  s.source = { :path => '.' }
  s.source_files = 'ios/**/*.swift'
  s.frameworks = 'UIKit'
  s.swift_version = '5.9'
  s.dependency 'ExpoModulesCore'
end
